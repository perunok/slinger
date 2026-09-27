/**
 * Postman collection `variable` arrays <-> Slinger collection variables. Shared by the main-process importer,
 * the renderer's exporter and the browser mock so a file is read and written identically everywhere.
 * No Node or DOM dependencies.
 */

/** A collection variable as data (snapshots, import, export). `enabled` is omitted when true. */
export interface CollectionVariableData {
  key: string
  value: string
  enabled?: boolean
  description?: string | null
}

/** Most collection variables taken from one file (matches the repository limit). */
export const MAX_COLLECTION_VARIABLES = 5000
const MAX_KEY = 256
const MAX_VALUE = 1_000_000

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Postman values may be any JSON (`type: "any"`, numbers, booleans): stored as text, strings as-is. */
function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return JSON.stringify(v)
}

function descriptionText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v
  if (isObj(v) && typeof v.content === 'string') return v.content.trim() === '' ? null : v.content
  return null
}

/**
 * A Postman `variable` array (collection level) to collection variables: keys trimmed, empty keys and oversized
 * entries skipped, the first of duplicate keys kept, `disabled: true` kept as disabled. Untrusted input: never throws.
 */
export function variablesFromPostman(list: unknown): CollectionVariableData[] {
  if (!Array.isArray(list)) return []
  const out: CollectionVariableData[] = []
  const seen = new Set<string>()
  for (const v of list) {
    if (out.length >= MAX_COLLECTION_VARIABLES) break
    if (!isObj(v)) continue
    const key = typeof v.key === 'string' ? v.key.trim() : typeof v.id === 'string' ? v.id.trim() : ''
    if (!key || key.length > MAX_KEY || seen.has(key)) continue
    const value = valueText(v.value)
    if (value.length > MAX_VALUE) continue
    seen.add(key)
    const item: CollectionVariableData = { key, value }
    if (v.disabled === true || v.enabled === false) item.enabled = false
    const description = descriptionText(v.description)
    if (description) item.description = description
    out.push(item)
  }
  return out
}

/** Postman v2.1 `variable` entries (`type: "string"`, `disabled: true` only for disabled ones). */
export function variablesToPostman(vars: readonly CollectionVariableData[]): Array<Record<string, unknown>> {
  return vars.map((v) => ({
    key: v.key,
    value: v.value,
    type: 'string',
    ...(v.enabled === false ? { disabled: true } : {}),
    ...(v.description ? { description: v.description } : {}),
  }))
}
