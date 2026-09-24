/** Pure helpers for the environment editor: validation, duplicates, bulk text, status summary. */

export interface Row {
  /** Stable client-side id (keeps focus while a row turns from blank into a real variable). */
  rid: string
  envId: string
  /** Server id; undefined until the first successful create. */
  id?: string
  key: string
  /** Plain value; for secrets only what the user typed or explicitly revealed (never loaded implicitly). */
  value: string
  isSecret: boolean
  /** The stored variable is currently a secret on the server. */
  serverSecret: boolean
  /** The user typed a new secret value (or one was revealed and edited). */
  secretTouched: boolean
  revealed: boolean
  deleted: boolean
}

let counter = 0
export const newRid = (): string => `r${Date.now().toString(36)}${(counter++).toString(36)}`

export function newRow(envId: string, patch: Partial<Row> = {}): Row {
  return { rid: newRid(), envId, key: '', value: '', isSecret: false, serverSecret: false, secretTouched: false, revealed: false, deleted: false, ...patch }
}

export const isBlank = (r: Row): boolean => !r.id && r.key === '' && r.value === '' && !r.isSecret

const KEY_RE = /^[A-Za-z_][\w.-]*$/

/** Returns an error message or null. Names must be letters/digits/`_ . -`, not start with a digit or `$`. */
export function validateKey(key: string): string | null {
  if (key === '') return 'Name is required'
  if (key.startsWith('$')) return 'Names starting with $ are reserved for built-in variables'
  if (/\s/.test(key)) return 'Names cannot contain spaces'
  if (/^[0-9]/.test(key)) return 'Names must start with a letter or _'
  if (!KEY_RE.test(key)) return 'Use only letters, digits, _ . and -'
  return null
}

/** rids of live rows whose (case-sensitive) key is shared with at least one other live row. */
export function findDuplicates(rows: Pick<Row, 'rid' | 'key' | 'deleted'>[]): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const r of rows) {
    if (r.deleted || r.key === '') continue
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.rid])
  }
  const out = new Set<string>()
  for (const ids of byKey.values()) if (ids.length > 1) ids.forEach((i) => out.add(i))
  return out
}

/** The distinct duplicated keys (for the summary banner). */
export function duplicateKeys(rows: Pick<Row, 'rid' | 'key' | 'deleted'>[]): string[] {
  const dups = findDuplicates(rows)
  return [...new Set(rows.filter((r) => dups.has(r.rid)).map((r) => r.key))]
}

/** Message explaining why a row cannot be saved right now, or null when it can. */
export function rowIssue(r: Row, duplicates: Set<string>): string | null {
  if (r.deleted || isBlank(r)) return null
  if (r.key === '') return r.value !== '' || r.id ? 'Name is required' : null
  const k = validateKey(r.key)
  if (k) return k
  if (duplicates.has(r.rid)) return `Duplicate name "${r.key}" - not saved until names are unique`
  if (r.serverSecret && !r.isSecret && r.value === '' && !r.secretTouched) {
    return 'Enter a value (or reveal the secret) before making it a plain variable'
  }
  return null
}

/** The value to send for a row: '' tells the backend to keep an unchanged stored secret. */
export function valueToSend(r: Row): string {
  return r.isSecret && r.serverSecret && !r.secretTouched ? '' : r.value
}

// ---- bulk edit ----------------------------------------------------------

export interface BulkEntry {
  key: string
  value: string
  line: number
}
export interface BulkParse {
  entries: BulkEntry[]
  errors: { line: number; message: string }[]
}

/** `key=value` per line; blank and `#` lines are ignored; key and value are trimmed. */
export function parseBulk(text: string): BulkParse {
  const entries: BulkEntry[] = []
  const errors: BulkParse['errors'] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const eq = line.indexOf('=')
    if (eq < 0) return void errors.push({ line: i + 1, message: 'Missing "="' })
    const key = line.slice(0, eq).trim()
    const bad = validateKey(key)
    if (bad) return void errors.push({ line: i + 1, message: bad })
    entries.push({ key, value: line.slice(eq + 1).trim(), line: i + 1 })
  })
  return { entries, errors }
}

/** Rows that can be represented as one `key=value` line. Secrets never are. */
export function bulkEligible(r: Row): boolean {
  return !r.deleted && !r.isSecret && !r.serverSecret && validateKey(r.key) === null && !/[\r\n]/.test(r.value) && r.value === r.value.trim()
}

export const serializeBulk = (rows: Row[]): string => rows.filter(bulkEligible).map((r) => `${r.key}=${r.value}`).join('\n')

export interface BulkDiff {
  update: { rid: string; value: string }[]
  create: { key: string; value: string }[]
  remove: string[]
}

/** Diff parsed bulk entries against the eligible rows (matching by exact key, first occurrence). */
export function diffBulk(rows: Row[], entries: BulkEntry[]): BulkDiff {
  const eligible = rows.filter(bulkEligible)
  const unmatched = new Set(eligible.map((r) => r.rid))
  const diff: BulkDiff = { update: [], create: [], remove: [] }
  for (const e of entries) {
    const hit = eligible.find((r) => unmatched.has(r.rid) && r.key === e.key)
    if (!hit) diff.create.push({ key: e.key, value: e.value })
    else {
      unmatched.delete(hit.rid)
      if (hit.value !== e.value) diff.update.push({ rid: hit.rid, value: e.value })
    }
  }
  diff.remove = [...unmatched]
  return diff
}

// ---- status -------------------------------------------------------------

export interface StatusCounts {
  dirty: number
  saving: number
  errors: number
  blocked: number
}
export type StatusKind = 'saved' | 'saving' | 'unsaved' | 'error'

export function summarizeStatus(c: StatusCounts): { kind: StatusKind; label: string } {
  if (c.errors > 0) return { kind: 'error', label: 'Error — retry' }
  if (c.saving > 0) return { kind: 'saving', label: 'Saving…' }
  const n = c.dirty + c.blocked
  if (n > 0) return { kind: 'unsaved', label: `${n} unsaved change${n === 1 ? '' : 's'}` }
  return { kind: 'saved', label: 'All changes saved' }
}
