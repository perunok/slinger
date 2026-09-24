import type { Environment, EnvironmentVariable, UpsertEnvironmentVariableInput } from '../../shared/types'
import { invalidInput, notFound } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { cleanName, nowSeconds } from '../lib/text'
import { envVarSecretKey, type SecretStore } from '../services/secrets'
import {
  requireEnvironment,
  requireWorkspace,
  toEnvironment,
  type Db,
  type EnvironmentRow,
} from './common'

export const SECRET_MASK = '••••••••'
const MAX_VALUE_LENGTH = 1_000_000

interface VariableRow {
  id: string
  environment_id: string
  key: string
  value: string | null
  is_secret: number
  secret_ref: string | null
  version: number
  created_at: number
  updated_at: number
}

/** Maps a row to the renderer shape. Secret values are never read from the keychain here. */
function toVariable(r: VariableRow): EnvironmentVariable {
  const secret = r.is_secret === 1
  return {
    id: r.id,
    environmentId: r.environment_id,
    key: r.key,
    value: secret ? null : r.value,
    isSecret: secret,
    maskedValue: secret ? SECRET_MASK : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  }
}

function cleanKey(key: unknown): string {
  if (typeof key !== 'string') throw invalidInput('variable key must be a string')
  const trimmed = key.trim()
  if (!trimmed) throw invalidInput('variable key is required')
  if (trimmed.length > 256) throw invalidInput('variable key must be at most 256 characters')
  return trimmed
}

export class EnvironmentRepository {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {}

  list(workspaceId: string): Environment[] {
    requireWorkspace(this.db, workspaceId)
    return (
      this.db
        .prepare('SELECT * FROM environments WHERE workspace_id = ? AND deleted = 0 ORDER BY created_at, id')
        .all(workspaceId.toLowerCase()) as EnvironmentRow[]
    ).map(toEnvironment)
  }

  get(id: string): Environment {
    return toEnvironment(requireEnvironment(this.db, id))
  }

  create(workspaceId: string, name: string): Environment {
    const ws = requireWorkspace(this.db, workspaceId)
    const clean = cleanName(name, 'environment name')
    const id = newId()
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT INTO environments (id, workspace_id, name, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, ws.id, clean, now, now)
    return this.get(id)
  }

  /** Returns the oldest live environment, creating "Local" when the workspace has none. */
  ensureDefault(workspaceId: string): Environment {
    return this.list(workspaceId)[0] ?? this.create(workspaceId, 'Local')
  }

  rename(id: string, name: string): Environment {
    requireEnvironment(this.db, id)
    this.db
      .prepare('UPDATE environments SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
      .run(cleanName(name, 'environment name'), nowSeconds(), id.toLowerCase())
    return this.get(id)
  }

  /** Soft-deletes the environment and its variables; secrets are purged from the keychain. */
  softDelete(id: string): void {
    const env = requireEnvironment(this.db, id)
    const now = nowSeconds()
    const refs = this.db.transaction(() => {
      const refs = (
        this.db
          .prepare(
            'SELECT secret_ref FROM environment_variables WHERE environment_id = ? AND deleted = 0 AND secret_ref IS NOT NULL',
          )
          .all(env.id) as Array<{ secret_ref: string }>
      ).map((r) => r.secret_ref)
      this.db
        .prepare('UPDATE environments SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(now, env.id)
      this.db
        .prepare(
          `UPDATE environment_variables SET deleted = 1, secret_ref = NULL, updated_at = ?, version = version + 1
           WHERE environment_id = ? AND deleted = 0`,
        )
        .run(now, env.id)
      return refs
    })()
    this.purgeSecrets(refs)
  }

  listVariables(environmentId: string): EnvironmentVariable[] {
    requireEnvironment(this.db, environmentId)
    return (
      this.db
        .prepare(
          `SELECT * FROM environment_variables WHERE environment_id = ? AND deleted = 0
           ORDER BY key COLLATE NOCASE, id`,
        )
        .all(environmentId.toLowerCase()) as VariableRow[]
    ).map(toVariable)
  }

  private getVariableRow(id: string): VariableRow {
    const row = this.db
      .prepare(
        `SELECT v.* FROM environment_variables v
         JOIN environments e ON e.id = v.environment_id JOIN workspaces w ON w.id = e.workspace_id
         WHERE v.id = ? AND v.deleted = 0 AND e.deleted = 0 AND w.deleted = 0`,
      )
      .get(assertUuid(id, 'variableId')) as VariableRow | undefined
    if (!row) throw notFound('environment variable')
    return row
  }

  /**
   * Create or update a variable. Updates target `variableId`, or the live variable with the same
   * key. For an existing variable an empty `value` means "keep the current value" (the renderer
   * never holds a secret's value, so it cannot resend it).
   */
  upsertVariable(input: UpsertEnvironmentVariableInput): EnvironmentVariable {
    const env = requireEnvironment(this.db, input.environmentId)
    const key = cleanKey(input.key)
    if (typeof input.value !== 'string') throw invalidInput('variable value must be a string')
    if (input.value.length > MAX_VALUE_LENGTH) throw invalidInput('variable value is too large')
    const isSecret = input.isSecret === true

    let existing: VariableRow | undefined
    if (input.variableId != null) {
      existing = this.getVariableRow(input.variableId)
      if (existing.environment_id !== env.id) throw invalidInput('variable belongs to a different environment')
    } else {
      existing = this.db
        .prepare('SELECT * FROM environment_variables WHERE environment_id = ? AND key = ? AND deleted = 0')
        .get(env.id, key) as VariableRow | undefined
    }
    if (existing && existing.key !== key) {
      const clash = this.db
        .prepare('SELECT 1 FROM environment_variables WHERE environment_id = ? AND key = ? AND deleted = 0 AND id != ?')
        .get(env.id, key, existing.id)
      if (clash) throw invalidInput(`a variable named "${key}" already exists in this environment`)
    }

    const now = nowSeconds()
    if (!existing) {
      if (isSecret && input.value === '') throw invalidInput('a secret variable needs a value')
      const id = newId()
      const ref = isSecret ? envVarSecretKey(id) : null
      if (ref) this.secrets.set(ref, input.value)
      try {
        this.db
          .prepare(
            `INSERT INTO environment_variables (id, environment_id, key, value, is_secret, secret_ref,
               version, deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
          )
          .run(id, env.id, key, isSecret ? null : input.value, isSecret ? 1 : 0, ref, now, now)
      } catch (err) {
        if (ref) this.secrets.delete(ref)
        throw err
      }
      return toVariable(this.getVariableRow(id))
    }

    const wasSecret = existing.is_secret === 1
    // Resolve the value that should be stored ("" = keep what is there now).
    let effective = input.value
    if (effective === '') {
      effective = wasSecret
        ? (this.secrets.get(existing.secret_ref ?? envVarSecretKey(existing.id)) ?? '')
        : (existing.value ?? '')
      if (isSecret && effective === '') throw invalidInput('a secret variable needs a value')
    }

    const ref = envVarSecretKey(existing.id)
    if (isSecret) this.secrets.set(ref, effective)
    this.db
      .prepare(
        `UPDATE environment_variables SET key = ?, value = ?, is_secret = ?, secret_ref = ?,
           updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0`,
      )
      .run(key, isSecret ? null : effective, isSecret ? 1 : 0, isSecret ? ref : null, now, existing.id)
    if (wasSecret && !isSecret) this.purgeSecrets([existing.secret_ref ?? ref])
    return toVariable(this.getVariableRow(existing.id))
  }

  deleteVariable(id: string): void {
    const row = this.getVariableRow(id)
    this.db
      .prepare(
        `UPDATE environment_variables SET deleted = 1, value = NULL, secret_ref = NULL, updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(nowSeconds(), row.id)
    if (row.secret_ref) this.purgeSecrets([row.secret_ref])
  }

  /** The only path that returns a secret's plaintext. Non-secret variables return their stored value. */
  reveal(id: string): string {
    const row = this.getVariableRow(id)
    if (row.is_secret !== 1) return row.value ?? ''
    const value = this.secrets.get(row.secret_ref ?? envVarSecretKey(row.id))
    if (value === null) throw notFound('secret value (missing from the OS keychain)')
    return value
  }

  private purgeSecrets(refs: string[]): void {
    for (const ref of refs) {
      try {
        this.secrets.delete(ref)
      } catch (err) {
        // The row is already gone from the DB, so the orphaned entry is unreachable through the app.
        console.warn(`[slinger] could not delete keychain entry ${ref}:`, err instanceof Error ? err.message : err)
      }
    }
  }
}
