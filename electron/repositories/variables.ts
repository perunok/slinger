/**
 * Persisted collection variables (per collection, never secret) and globals (per workspace, secrets like
 * environment variables). Both tables are local-only (migration 0008: no sync capture triggers) and share one
 * implementation, parameterised by the owner column and whether secrets are allowed.
 *
 * Upsert rules (shared with environment variables where they overlap): a variable is addressed by id, else by key;
 * keys are unique per owner among live rows; an empty value on an existing *secret* keeps the stored secret (the
 * renderer never holds it). Plain values are stored exactly, so a variable can be emptied.
 */
import type {
  CollectionVariable,
  GlobalVariable,
  UpsertCollectionVariableInput,
  UpsertGlobalVariableInput,
  VariableEntryInput,
} from '../../shared/types'
import { invalidInput, notFound, versionConflict } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import { globalVarSecretKey, purgeSecretRefs, type SecretStore } from '../services/secrets'
import { requireCollection, requireWorkspace, type Db } from './common'
import { SECRET_MASK } from './environments'

const MAX_VALUE_LENGTH = 1_000_000
const MAX_DESCRIPTION_LENGTH = 100_000
/** Most variables one owner can hold (bulk replace, import). */
export const MAX_VARIABLES = 5000

interface Row {
  id: string
  workspace_id: string
  collection_id?: string
  key: string
  value: string | null
  is_secret?: number
  secret_ref?: string | null
  enabled: number
  description: string | null
  sort_order: number
  version: number
  created_at: number
  updated_at: number
}

function cleanKey(key: unknown): string {
  if (typeof key !== 'string') throw invalidInput('variable key must be a string')
  const trimmed = key.trim()
  if (!trimmed) throw invalidInput('variable key is required')
  if (trimmed.length > 256) throw invalidInput('variable key must be at most 256 characters')
  return trimmed
}

function cleanValue(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('variable value must be a string')
  if (value.length > MAX_VALUE_LENGTH) throw invalidInput('variable value is too large')
  return value
}

function cleanDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw invalidInput('variable description must be a string or null')
  if (value.length > MAX_DESCRIPTION_LENGTH) throw invalidInput('variable description is too large')
  return value.trim() === '' ? null : value
}

/** A value a script stored (strings as-is, anything else as JSON), as persisted text. */
export interface ScriptVarRecord {
  id: string
  key: string
  /** null for secrets (read on demand). */
  value: string | null
  secret: boolean
}

interface Config {
  table: 'collection_variables' | 'global_variables'
  ownerColumn: 'collection_id' | 'workspace_id'
  /** Label for messages. */
  what: string
  secrets: boolean
}

interface NormalizedUpsert {
  ownerId: string
  key: string
  value: string
  isSecret: boolean
  enabled?: boolean
  description?: string | null
  variableId?: string
  expectedVersion?: number
}

/** Shared SQL for both scopes. `ownerId` is the collection id (collection variables) or workspace id (globals). */
abstract class ScopedVariableRepository<T> {
  constructor(
    protected readonly db: Db,
    protected readonly secretStore: SecretStore | undefined,
    private readonly cfg: Config,
  ) {}

  /** Validates the owner and returns [ownerId, workspaceId]. */
  protected abstract owner(ownerId: string): { id: string; workspaceId: string }
  protected abstract toApi(row: Row): T

  private rows(ownerId: string): Row[] {
    return this.db
      .prepare(`SELECT * FROM ${this.cfg.table} WHERE ${this.cfg.ownerColumn} = ? AND deleted = 0 ORDER BY sort_order, created_at, id`)
      .all(ownerId) as Row[]
  }

  list(ownerId: string): T[] {
    return this.rows(this.owner(ownerId).id).map((r) => this.toApi(r))
  }

  /** Live row by id with a live owner. */
  protected getRow(id: string): Row {
    const row = this.db
      .prepare(`SELECT * FROM ${this.cfg.table} WHERE id = ? AND deleted = 0`)
      .get(assertUuid(id, 'variableId')) as Row | undefined
    if (!row) throw notFound(this.cfg.what)
    this.owner(row[this.cfg.ownerColumn] as string) // the owner (and its workspace) must be live too
    return row
  }

  private byKey(ownerId: string, key: string): Row | undefined {
    return this.db
      .prepare(`SELECT * FROM ${this.cfg.table} WHERE ${this.cfg.ownerColumn} = ? AND key = ? AND deleted = 0`)
      .get(ownerId, key) as Row | undefined
  }

  private nextSortOrder(ownerId: string): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${this.cfg.table} WHERE ${this.cfg.ownerColumn} = ? AND deleted = 0`)
        .get(ownerId) as { n: number }
    ).n
  }

  private secretKey(id: string): string {
    return globalVarSecretKey(id)
  }

  /** Stored secret value of a row ('' when missing from the keychain). */
  private storedSecret(row: Row): string {
    return this.secretStore?.get(row.secret_ref ?? this.secretKey(row.id)) ?? ''
  }

  private insertRow(owner: { id: string; workspaceId: string }, key: string, value: string, isSecret: boolean, enabled: boolean,
    description: string | null, sortOrder: number, now: number): string {
    const id = newId()
    const ref = isSecret ? this.secretKey(id) : null
    // The row first, the keychain last: a refused row (read-only trigger, unique key) never writes a secret, and a
    // keychain failure throws inside the caller's transaction, which rolls the row back.
    if (this.cfg.secrets) {
      this.db
        .prepare(
          `INSERT INTO global_variables (id, workspace_id, key, value, is_secret, secret_ref, enabled, description, sort_order,
             version, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(id, owner.workspaceId, key, isSecret ? null : value, isSecret ? 1 : 0, ref, enabled ? 1 : 0, description, sortOrder, now, now)
    } else {
      this.db
        .prepare(
          `INSERT INTO collection_variables (id, workspace_id, collection_id, key, value, enabled, description, sort_order,
             version, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(id, owner.workspaceId, owner.id, key, value, enabled ? 1 : 0, description, sortOrder, now, now)
    }
    if (ref) this.requireStore().set(ref, value)
    return id
  }

  private requireStore(): SecretStore {
    if (!this.secretStore) throw invalidInput('secret storage is not available')
    return this.secretStore
  }

  /**
   * Updates a row in place. `value === ''` on a secret that stays secret keeps the stored secret. Returns the
   * keychain refs to purge after the surrounding transaction (secret -> plain).
   */
  private updateRow(existing: Row, key: string, value: string, isSecret: boolean, enabled: boolean, description: string | null,
    sortOrder: number, now: number): string[] {
    const wasSecret = existing.is_secret === 1
    if (!this.cfg.secrets) {
      this.db
        .prepare(
          `UPDATE collection_variables SET key = ?, value = ?, enabled = ?, description = ?, sort_order = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND deleted = 0`,
        )
        .run(key, value, enabled ? 1 : 0, description, sortOrder, now, existing.id)
      return []
    }
    let effective = value
    if (effective === '' && isSecret && wasSecret) effective = this.storedSecret(existing)
    if (isSecret && effective === '') throw invalidInput('a secret variable needs a value')
    const ref = existing.secret_ref ?? this.secretKey(existing.id)
    this.db
      .prepare(
        `UPDATE global_variables SET key = ?, value = ?, is_secret = ?, secret_ref = ?, enabled = ?, description = ?, sort_order = ?,
           updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0`,
      )
      .run(key, isSecret ? null : effective, isSecret ? 1 : 0, isSecret ? ref : null, enabled ? 1 : 0, description, sortOrder, now, existing.id)
    if (isSecret) this.requireStore().set(ref, effective) // after the row (see insertRow)
    return wasSecret && !isSecret ? [ref] : []
  }

  protected upsertNormalized(input: NormalizedUpsert): T {
    const owner = this.owner(input.ownerId)
    const key = cleanKey(input.key)
    const value = cleanValue(input.value)
    if (input.isSecret && !this.cfg.secrets) throw invalidInput(`${this.cfg.what}s cannot be secret`)
    const description = input.description === undefined ? undefined : cleanDescription(input.description)

    const purge = this.db.transaction((): { id: string; purge: string[] } => {
      let existing: Row | undefined
      if (input.variableId != null) {
        existing = this.getRow(input.variableId)
        if (existing[this.cfg.ownerColumn] !== owner.id) throw invalidInput(`the variable belongs to a different ${this.cfg.ownerColumn === 'collection_id' ? 'collection' : 'workspace'}`)
      } else {
        existing = this.byKey(owner.id, key)
      }
      if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        throw versionConflict(`${this.cfg.what} was modified elsewhere; reload and retry`, {
          expectedVersion: input.expectedVersion,
          currentVersion: existing.version,
        })
      }
      if (existing && existing.key !== key && this.byKey(owner.id, key)) {
        throw invalidInput(`a variable named "${key}" already exists`)
      }
      const now = nowSeconds()
      if (!existing) {
        if (input.isSecret && value === '') throw invalidInput('a secret variable needs a value')
        const id = this.insertRow(owner, key, value, input.isSecret, input.enabled ?? true, description ?? null, this.nextSortOrder(owner.id), now)
        return { id, purge: [] }
      }
      const refs = this.updateRow(existing, key, value, input.isSecret, input.enabled ?? existing.enabled === 1,
        description === undefined ? existing.description : description, existing.sort_order, now)
      return { id: existing.id, purge: refs }
    })()
    purgeSecretRefs(this.secretStore, purge.purge)
    return this.toApi(this.getRow(purge.id))
  }

  delete(id: string): void {
    const row = this.getRow(id)
    this.db
      .prepare(`UPDATE ${this.cfg.table} SET deleted = 1, ${this.cfg.secrets ? 'value = NULL, secret_ref = NULL, ' : ''}updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(nowSeconds(), row.id)
    if (row.secret_ref) purgeSecretRefs(this.secretStore, [row.secret_ref])
  }

  /**
   * Sets the order of the owner's variables. `ids` must be exactly the live variables. Only `sort_order`
   * changes (not `version`), like reordering folders/requests.
   */
  reorder(ownerId: string, ids: string[]): T[] {
    const owner = this.owner(ownerId)
    const live = this.rows(owner.id)
    const wanted = ids.map((id) => assertUuid(id, 'variableId').toLowerCase())
    const liveIds = new Set(live.map((r) => r.id))
    if (wanted.length !== live.length || new Set(wanted).size !== wanted.length || wanted.some((id) => !liveIds.has(id))) {
      throw invalidInput('reorder needs every live variable exactly once')
    }
    const update = this.db.prepare(`UPDATE ${this.cfg.table} SET sort_order = ? WHERE id = ?`)
    this.db.transaction(() => wanted.forEach((id, i) => update.run(i, id)))()
    return this.list(owner.id)
  }

  /**
   * Bulk replace: afterwards the owner has exactly `entries`, in that order. Existing keys are updated in place
   * (ids kept), new keys inserted, missing keys soft-deleted. Runs in one transaction; keychain entries of deleted
   * or de-secreted globals are purged afterwards. Call from inside another transaction to make it part of it.
   */
  replace(ownerId: string, entries: VariableEntryInput[]): T[] {
    const owner = this.owner(ownerId)
    if (!Array.isArray(entries)) throw invalidInput('variables must be a list')
    if (entries.length > MAX_VARIABLES) throw invalidInput(`at most ${MAX_VARIABLES} variables`)
    const clean = entries.map((e) => {
      if (!e || typeof e !== 'object') throw invalidInput('each variable must be an object')
      if (e.isSecret === true && !this.cfg.secrets) throw invalidInput(`${this.cfg.what}s cannot be secret`)
      return {
        key: cleanKey(e.key),
        value: cleanValue(e.value),
        enabled: e.enabled !== false,
        description: cleanDescription(e.description),
        isSecret: e.isSecret === true,
      }
    })
    const seen = new Set<string>()
    for (const e of clean) {
      if (seen.has(e.key)) throw invalidInput(`duplicate variable name "${e.key}"`)
      seen.add(e.key)
    }
    const purge = this.db.transaction((): string[] => {
      const now = nowSeconds()
      const existing = new Map(this.rows(owner.id).map((r) => [r.key, r]))
      const refs: string[] = []
      // Delete first, so a key freed by a delete can never clash.
      for (const [key, row] of existing) {
        if (seen.has(key)) continue
        this.db
          .prepare(`UPDATE ${this.cfg.table} SET deleted = 1, ${this.cfg.secrets ? 'value = NULL, secret_ref = NULL, ' : ''}updated_at = ?, version = version + 1 WHERE id = ?`)
          .run(now, row.id)
        if (row.secret_ref) refs.push(row.secret_ref)
      }
      clean.forEach((e, i) => {
        const row = existing.get(e.key)
        if (row) {
          const same = row.value === (e.isSecret ? null : e.value) && (row.is_secret === 1) === e.isSecret && (row.enabled === 1) === e.enabled &&
            row.description === e.description && !(e.isSecret && e.value !== '')
          if (same) {
            if (row.sort_order !== i) this.db.prepare(`UPDATE ${this.cfg.table} SET sort_order = ? WHERE id = ?`).run(i, row.id)
          } else refs.push(...this.updateRow(row, e.key, e.value, e.isSecret, e.enabled, e.description, i, now))
        } else {
          if (e.isSecret && e.value === '') throw invalidInput(`secret variable "${e.key}" needs a value`)
          this.insertRow(owner, e.key, e.value, e.isSecret, e.enabled, e.description, i, now)
        }
      })
      return refs
    })()
    purgeSecretRefs(this.secretStore, purge)
    return this.list(owner.id)
  }

  // ---- scripts ------------------------------------------------------------------

  /** Enabled variables as the script sandbox sees them (secret values are not included). */
  forScripts(ownerId: string): ScriptVarRecord[] {
    return this.rows(this.owner(ownerId).id)
      .filter((r) => r.enabled === 1)
      .map((r) => ({ id: r.id, key: r.key, value: r.is_secret === 1 ? null : (r.value ?? ''), secret: r.is_secret === 1 }))
  }

  /**
   * A script's `set(key, value)`: writes exactly `value` ("" empties a plain variable). A secret global stays
   * secret (value to the keychain); a disabled variable is enabled (the script wants the value to be used); an
   * unknown key becomes a new plain variable at the end. Returns whether the variable is secret.
   */
  setValueFromScript(ownerId: string, key: string, value: string): { secret: boolean } {
    const owner = this.owner(ownerId)
    const clean = cleanKey(key)
    cleanValue(value)
    return this.db.transaction(() => this.setInTx(owner, clean, value))()
  }

  private setInTx(owner: { id: string; workspaceId: string }, clean: string, value: string): { secret: boolean } {
    const existing = this.byKey(owner.id, clean)
    const now = nowSeconds()
    if (!existing) {
      this.insertRow(owner, clean, value, false, true, null, this.nextSortOrder(owner.id), now)
      return { secret: false }
    }
    if (existing.is_secret === 1) {
      if (value === '') throw invalidInput(`"${clean}" is a secret variable and cannot be empty`)
      const ref = existing.secret_ref ?? this.secretKey(existing.id)
      this.db
        .prepare('UPDATE global_variables SET secret_ref = ?, enabled = 1, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(ref, now, existing.id)
      this.requireStore().set(ref, value)
      return { secret: true }
    }
    if (existing.value !== value || existing.enabled !== 1) {
      this.db
        .prepare(`UPDATE ${this.cfg.table} SET value = ?, enabled = 1, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(value, now, existing.id)
    }
    return { secret: false }
  }

  /** A script's `unset(key)`; unknown keys are ignored. */
  unsetFromScript(ownerId: string, key: string): void {
    const owner = this.owner(ownerId)
    const row = this.byKey(owner.id, cleanKey(key))
    if (row) this.delete(row.id)
  }

  /** A script's `clear()`: deletes every variable of the owner (disabled ones too, as in Postman). */
  clearFromScript(ownerId: string): void {
    this.replace(ownerId, [])
  }

  /** Soft-deletes every live variable of `ownerIds` (cascade inside the caller's transaction); returns keychain refs. */
  static cascadeSql(db: Db, table: Config['table'], where: string, args: unknown[], now: number): string[] {
    const refs =
      table === 'global_variables'
        ? (db.prepare(`SELECT secret_ref FROM global_variables WHERE ${where} AND deleted = 0 AND secret_ref IS NOT NULL`).all(...args) as Array<{ secret_ref: string }>).map((r) => r.secret_ref)
        : []
    db.prepare(
      `UPDATE ${table} SET deleted = 1, ${table === 'global_variables' ? 'value = NULL, secret_ref = NULL, ' : ''}updated_at = ?, version = version + 1
       WHERE ${where} AND deleted = 0`,
    ).run(now, ...args)
    return refs
  }
}

export class CollectionVariableRepository extends ScopedVariableRepository<CollectionVariable> {
  constructor(db: Db) {
    super(db, undefined, { table: 'collection_variables', ownerColumn: 'collection_id', what: 'collection variable', secrets: false })
  }

  protected owner(collectionId: string) {
    const c = requireCollection(this.db, collectionId)
    return { id: c.id, workspaceId: c.workspace_id }
  }

  protected toApi(r: Row): CollectionVariable {
    return {
      id: r.id,
      collectionId: r.collection_id!,
      key: r.key,
      value: r.value ?? '',
      enabled: r.enabled === 1,
      description: r.description,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: r.version,
    }
  }

  upsert(input: UpsertCollectionVariableInput): CollectionVariable {
    if (input.isSecret === true) throw invalidInput('collection variables cannot be secret (use a global or an environment variable)')
    return this.upsertNormalized({ ...input, ownerId: input.collectionId, isSecret: false })
  }
}

export class GlobalVariableRepository extends ScopedVariableRepository<GlobalVariable> {
  constructor(db: Db, secrets: SecretStore) {
    super(db, secrets, { table: 'global_variables', ownerColumn: 'workspace_id', what: 'global variable', secrets: true })
  }

  protected owner(workspaceId: string) {
    const w = requireWorkspace(this.db, workspaceId)
    return { id: w.id, workspaceId: w.id }
  }

  protected toApi(r: Row): GlobalVariable {
    const secret = r.is_secret === 1
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      key: r.key,
      value: secret ? null : r.value,
      isSecret: secret,
      maskedValue: secret ? SECRET_MASK : null,
      enabled: r.enabled === 1,
      description: r.description,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: r.version,
    }
  }

  upsert(input: UpsertGlobalVariableInput): GlobalVariable {
    return this.upsertNormalized({ ...input, ownerId: input.workspaceId, isSecret: input.isSecret === true })
  }

  /** The only path that returns a secret global's plaintext. Non-secret variables return their stored value. */
  reveal(id: string): string {
    const row = this.getRow(id)
    if (row.is_secret !== 1) return row.value ?? ''
    const value = this.secretStore!.get(row.secret_ref ?? globalVarSecretKey(row.id))
    if (value === null) throw notFound('secret value (missing from the OS keychain)')
    return value
  }
}

/** Collection soft delete cascade (inside the caller's transaction). Collection variables hold no secrets. */
export function cascadeCollectionVariables(db: Db, collectionId: string, now: number): void {
  ScopedVariableRepository.cascadeSql(db, 'collection_variables', 'collection_id = ?', [collectionId], now)
}

/** Workspace soft delete cascade (inside the caller's transaction); returns the globals' keychain refs to purge. */
export function cascadeWorkspaceVariables(db: Db, workspaceId: string, now: number): string[] {
  ScopedVariableRepository.cascadeSql(db, 'collection_variables', 'workspace_id = ?', [workspaceId], now)
  return ScopedVariableRepository.cascadeSql(db, 'global_variables', 'workspace_id = ?', [workspaceId], now)
}
