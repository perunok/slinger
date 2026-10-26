/**
 * Local-only security state (migration 0019): which collections may run their scripts on this device, and what an AI
 * assistant changed that the user has not reviewed since. Neither is synced, exported or versioned.
 */
import { createHash } from 'node:crypto'
import type { AssistantChangeRef, AssistantChanges } from '../../shared/types'
import type { Db } from '../db/database'
import { invalidInput } from '../lib/errors'
import { assertUuid } from '../lib/ids'
import { nowSeconds } from '../lib/text'
import { requireCollection, requireEnvironment, requireRequest } from './common'

/** Marks a collection made on this device as trusted (its scripts run without asking). */
export function trustCollectionRow(db: Db, collectionId: string): void {
  db.prepare('INSERT OR IGNORE INTO collection_trust (collection_id, trusted_at) VALUES (?, ?)').run(collectionId.toLowerCase(), nowSeconds())
}

/** A collection derived from another one (extract folder, restore as a copy) is trusted when its source is. */
export function copyCollectionTrust(db: Db, fromId: string, toId: string): void {
  if (isCollectionTrustedRow(db, fromId)) trustCollectionRow(db, toId)
}

export function isCollectionTrustedRow(db: Db, collectionId: string): boolean {
  return !!db.prepare('SELECT 1 FROM collection_trust WHERE collection_id = ?').get(collectionId.toLowerCase())
}

/** A change recorded before the write (`pending`): it counts whatever the content is, until replaced. */
const ANY_CONTENT = '*'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** What a request sends: method, URL and the document without its saved examples (`responses`) and name. */
export function requestFingerprint(row: { method: string; url: string; document_json: string }): string {
  let doc: unknown
  try {
    doc = JSON.parse(row.document_json)
  } catch {
    doc = row.document_json
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const { responses: _responses, name: _name, ...rest } = doc as Record<string, unknown>
    doc = rest
  }
  return sha256(JSON.stringify(['request-v1', row.method, row.url, doc]))
}

interface VariableRow {
  value: string | null
  is_secret: number
  version: number
}

/** A plain value by its text; a secret (in the keychain) by its row version, which every write bumps. */
const variableFingerprint = (v: VariableRow) => sha256(JSON.stringify(['variable-v1', v.is_secret ? 1 : 0, v.is_secret ? v.version : v.value]))

function variableRow(db: Db, environmentId: string, key: string): VariableRow | undefined {
  return db
    .prepare('SELECT value, is_secret, version FROM environment_variables WHERE environment_id = ? AND key = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT 1')
    .get(environmentId.toLowerCase(), key) as VariableRow | undefined
}

export class TrustRepository {
  constructor(private readonly db: Db) {}

  isCollectionTrusted(collectionId: string): boolean {
    return isCollectionTrustedRow(this.db, assertUuid(collectionId, 'collectionId'))
  }

  /** The user allowed the collection's scripts on this device. */
  trustCollection(collectionId: string): void {
    const c = requireCollection(this.db, collectionId)
    trustCollectionRow(this.db, c.id)
  }

  /** Records the current content of a request or variable as written by an AI assistant. */
  markAssistantChange(ref: AssistantChangeRef): void {
    const now = nowSeconds()
    const put = (kind: string, key: string, workspaceId: string, fingerprint: string, created: boolean) =>
      this.db
        .prepare(
          `INSERT INTO assistant_changes (kind, ref, workspace_id, fingerprint, created, changed_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, ref) DO UPDATE SET workspace_id = excluded.workspace_id, fingerprint = excluded.fingerprint,
             created = excluded.created, changed_at = excluded.changed_at`,
        )
        .run(kind, key, workspaceId, fingerprint, created ? 1 : 0, now)
    if (ref.kind === 'request') {
      const r = requireRequest(this.db, ref.requestId)
      put('request', r.id, r.workspace_id, ref.pending ? ANY_CONTENT : requestFingerprint(r), ref.created === true)
      return
    }
    const env = requireEnvironment(this.db, ref.environmentId)
    const v = variableRow(this.db, env.id, ref.key)
    if (!v && !ref.pending) throw invalidInput(`No variable "${ref.key}" in this environment`)
    put('variable', `${env.id}:${ref.key}`, env.workspace_id, ref.pending || !v ? ANY_CONTENT : variableFingerprint(v), false)
  }

  /** The user reviewed it (saved the request or the variable in the window). Unknown refs are a no-op. */
  clearAssistantChange(ref: AssistantChangeRef): void {
    const key = ref.kind === 'request' ? assertUuid(ref.requestId, 'requestId').toLowerCase() : `${assertUuid(ref.environmentId, 'environmentId').toLowerCase()}:${ref.key}`
    this.db.prepare('DELETE FROM assistant_changes WHERE kind = ? AND ref = ?').run(ref.kind, key)
  }

  /** The assistant changes of a workspace whose content is still what the assistant wrote. */
  listAssistantChanges(workspaceId: string): AssistantChanges {
    const ws = assertUuid(workspaceId, 'workspaceId').toLowerCase()
    const rows = this.db.prepare('SELECT kind, ref, fingerprint, created FROM assistant_changes WHERE workspace_id = ?').all(ws) as Array<{
      kind: 'request' | 'variable'
      ref: string
      fingerprint: string
      created: number
    }>
    const out: AssistantChanges = { requests: [], variables: [] }
    for (const row of rows) {
      if (row.kind === 'request') {
        const r = this.db.prepare('SELECT method, url, document_json FROM requests WHERE id = ? AND deleted = 0').get(row.ref) as
          | { method: string; url: string; document_json: string }
          | undefined
        if (r && (row.fingerprint === ANY_CONTENT || requestFingerprint(r) === row.fingerprint)) out.requests.push({ requestId: row.ref, created: row.created === 1 })
      } else {
        const sep = row.ref.indexOf(':')
        const environmentId = row.ref.slice(0, sep)
        const key = row.ref.slice(sep + 1)
        const v = variableRow(this.db, environmentId, key)
        if (v && (row.fingerprint === ANY_CONTENT || variableFingerprint(v) === row.fingerprint)) out.variables.push({ environmentId, key })
      }
    }
    return out
  }
}
