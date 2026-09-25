/**
 * Postman v2.0/v2.1 `url` (string or object) to a plain URL string. Shared by the main-process importer, the
 * renderer (examples) and the dev mock backend so all three read URLs the same way.
 *
 * `url.raw` wins when present (the Postman app always writes it). Without it (Postman's SDK / Newman
 * `toJSON()` drop `raw`) the URL is rebuilt from protocol, host, port, path, enabled query params and hash,
 * like the SDK's `Url#toString()` but without substituting `:path` variables.
 */
type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function joinParts(parts: unknown, separator: string): string {
  if (typeof parts === 'string') return parts
  return Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string').join(separator) : ''
}

function queryString(query: unknown): string {
  if (!Array.isArray(query)) return ''
  return query
    .filter((q): q is Json => isObj(q) && q.disabled !== true && typeof q.key === 'string')
    .map((q) => (q.value === null || q.value === undefined ? (q.key as string) : `${q.key as string}=${String(q.value)}`))
    .join('&')
}

export function postmanUrlToString(url: unknown): string {
  if (typeof url === 'string') return url
  if (!isObj(url)) return ''
  if (typeof url.raw === 'string') return url.raw
  const host = joinParts(url.host, '.')
  const path = joinParts(url.path, '/')
  const port = typeof url.port === 'string' && url.port ? `:${url.port}` : ''
  let out = host && path ? `${host.replace(/\/+$/, '')}${port}/${path}` : host ? `${host}${port}` : path
  if (host && typeof url.protocol === 'string' && url.protocol) out = `${url.protocol.replace(/:?\/*$/, '')}://${out}`
  const query = queryString(url.query)
  if (query) out += `?${query}`
  if (typeof url.hash === 'string' && url.hash) out += `#${url.hash}`
  return out
}
