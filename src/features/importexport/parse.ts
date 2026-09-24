/** Recognises Postman collection (v2.x) and environment exports before anything is sent to the backend. */

export interface CollectionVariable {
  key: string
  value: string
  secret: boolean
}

export type PostmanFile =
  | { kind: 'collection'; name: string; folders: number; requests: number; variables: CollectionVariable[] }
  | { kind: 'environment'; name: string; variables: CollectionVariable[]; skippedDisabled: number }

export type ParseResult = { ok: true; file: PostmanFile } | { ok: false; error: string }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function variablesOf(list: unknown, secretByType: boolean): { vars: CollectionVariable[]; skipped: number } {
  const vars: CollectionVariable[] = []
  let skipped = 0
  if (!Array.isArray(list)) return { vars, skipped }
  for (const v of list) {
    if (!isObj(v) || typeof v.key !== 'string' || v.key.trim() === '') continue
    if (v.enabled === false || v.disabled === true) {
      skipped++
      continue
    }
    const value = v.value === undefined || v.value === null ? '' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value)
    vars.push({ key: v.key.trim(), value, secret: secretByType && v.type === 'secret' })
  }
  return { vars, skipped }
}

function countItems(items: unknown[]): { folders: number; requests: number } {
  let folders = 0
  let requests = 0
  for (const it of items) {
    if (!isObj(it)) continue
    if (Array.isArray(it.item)) {
      folders++
      const inner = countItems(it.item)
      folders += inner.folders
      requests += inner.requests
    } else if (it.request !== undefined) requests++
  }
  return { folders, requests }
}

export function parsePostmanFile(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `This file is not valid JSON (${e instanceof Error ? e.message : String(e)}).` }
  }
  if (!isObj(data)) return { ok: false, error: 'This is JSON, but not a Postman export: expected an object at the top level.' }

  if (data._postman_variable_scope === 'environment' && Array.isArray(data.values)) {
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Imported environment'
    const { vars, skipped } = variablesOf(data.values, true)
    return { ok: true, file: { kind: 'environment', name, variables: vars, skippedDisabled: skipped } }
  }
  if (data._postman_variable_scope === 'globals') {
    return { ok: false, error: 'Postman globals are not supported. Export the environment instead.' }
  }

  const info = isObj(data.info) ? data.info : null
  const schema = info && typeof info.schema === 'string' ? info.schema : ''
  if (schema && !/collection\/v2/i.test(schema) && !Array.isArray(data.item)) {
    return { ok: false, error: `Unsupported Postman schema: ${schema}. Only collection v2.x is supported.` }
  }
  if (!Array.isArray(data.item)) {
    return { ok: false, error: 'This does not look like a Postman collection v2.x: it has no "item" array.' }
  }
  const { folders, requests } = countItems(data.item)
  if (requests === 0) return { ok: false, error: 'This collection contains no requests.' }
  const name = info && typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'Imported Collection'
  return { ok: true, file: { kind: 'collection', name, folders, requests, variables: variablesOf(data.variable, false).vars } }
}
