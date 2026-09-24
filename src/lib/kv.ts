/**
 * Key/value row model shared by params, headers, form-data and urlencoded tables,
 * plus the pure logic behind KeyValueTable (auto-append row, bulk edit, duplicates).
 */

export interface KvRow {
  /** Stable identity so keyed lists keep focus while other state changes. */
  id: string
  key: string
  value: string
  enabled: boolean
  description: string
  /** Only meaningful for form-data. */
  kind: 'text' | 'file'
  filePath: string
}

let counter = 0
export function nextId(prefix = 'r'): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`
}

export function newRow(partial: Partial<KvRow> = {}): KvRow {
  return {
    id: partial.id ?? nextId(),
    key: '',
    value: '',
    enabled: true,
    description: '',
    kind: 'text',
    filePath: '',
    ...partial,
  }
}

export function isEmptyRow(row: KvRow): boolean {
  return !row.key && !row.value && !row.description && !row.filePath
}

/** Guarantees exactly one blank row at the end (never removes user rows in the middle). */
export function ensureTrailingEmpty(rows: KvRow[]): KvRow[] {
  const out = [...rows]
  while (out.length > 1 && isEmptyRow(out[out.length - 1]) && isEmptyRow(out[out.length - 2])) out.pop()
  if (out.length === 0 || !isEmptyRow(out[out.length - 1])) out.push(newRow())
  return out
}

/** Rows that carry data (used for serialisation and sending). */
export function dataRows(rows: KvRow[]): KvRow[] {
  return rows.filter((r) => !isEmptyRow(r))
}

export function updateRow(rows: KvRow[], id: string, patch: Partial<KvRow>): KvRow[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
}

export function removeRow(rows: KvRow[], id: string): KvRow[] {
  return ensureTrailingEmpty(rows.filter((r) => r.id !== id))
}

export function moveRow(rows: KvRow[], from: number, to: number): KvRow[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows
  const out = [...rows]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

export function findDuplicateKeys(rows: KvRow[], caseInsensitive = false): Set<string> {
  const seen = new Map<string, number>()
  const norm = (k: string) => (caseInsensitive ? k.trim().toLowerCase() : k.trim())
  for (const r of rows) {
    if (!r.enabled || !r.key.trim()) continue
    const k = norm(r.key)
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k))
}

export function isDuplicate(row: KvRow, dups: Set<string>, caseInsensitive = false): boolean {
  if (!row.enabled || !row.key.trim()) return false
  return dups.has(caseInsensitive ? row.key.trim().toLowerCase() : row.key.trim())
}

// ----- bulk edit ("key: value" per line; `//` or `#` prefix disables the line) -----

export function serializeBulk(rows: KvRow[]): string {
  return dataRows(rows)
    .map((r) => `${r.enabled ? '' : '//'}${r.key}: ${r.value}`)
    .join('\n')
}

/**
 * Parses bulk text. Existing rows are reused positionally (by index) so ids and
 * descriptions survive a bulk edit; extra lines create new rows.
 */
export function parseBulk(text: string, previous: KvRow[] = []): KvRow[] {
  const prev = dataRows(previous)
  const rows: KvRow[] = []
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    let line = rawLine
    if (!line.trim()) continue
    let enabled = true
    const m = /^\s*(\/\/|#)\s?/.exec(line)
    if (m) {
      enabled = false
      line = line.slice(m[0].length)
    }
    const idx = line.indexOf(':')
    const key = (idx >= 0 ? line.slice(0, idx) : line).trim()
    const value = idx >= 0 ? line.slice(idx + 1).replace(/^\s/, '') : ''
    if (!key && !value) continue
    const old = prev[rows.length]
    rows.push(newRow({ ...(old ? { id: old.id, description: old.description, kind: old.kind, filePath: old.filePath } : {}), key, value, enabled }))
  }
  return ensureTrailingEmpty(rows)
}

/** Serialises rows for the document: drops the trailing blank row only. */
export function toStored(rows: KvRow[]): KvRow[] {
  return dataRows(rows)
}
