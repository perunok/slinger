/** Suggestions for the header table: names and per-header value hints. */

export const COMMON_HEADERS = [
  'Accept',
  'Accept-Charset',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Encoding',
  'Content-Language',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'DNT',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'Origin',
  'Pragma',
  'Range',
  'Referer',
  'User-Agent',
  'X-API-Key',
  'X-Forwarded-For',
  'X-Request-ID',
  'X-Requested-With',
]

export const MIME_TYPES = [
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded',
  'application/octet-stream',
  'application/pdf',
  'application/javascript',
  'application/graphql',
  'multipart/form-data',
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/xml',
  'image/png',
  'image/jpeg',
  '*/*',
]

const VALUE_HINTS: Record<string, string[]> = {
  'content-type': MIME_TYPES.filter((m) => m !== '*/*'),
  accept: ['application/json', 'application/xml', 'text/html', 'text/plain', '*/*'],
  authorization: ['Bearer ', 'Basic '],
  'cache-control': ['no-cache', 'no-store', 'max-age=0', 'max-age=3600', 'public', 'private'],
  'accept-encoding': ['gzip, deflate, br', 'gzip', 'identity'],
  connection: ['keep-alive', 'close'],
  'accept-language': ['en-US,en;q=0.9', 'en'],
  'x-requested-with': ['XMLHttpRequest'],
}

function rank(items: string[], query: string): string[] {
  const q = query.toLowerCase()
  if (!q) return items
  const starts = items.filter((i) => i.toLowerCase().startsWith(q))
  const contains = items.filter((i) => !i.toLowerCase().startsWith(q) && i.toLowerCase().includes(q))
  return [...starts, ...contains].filter((i) => i.toLowerCase() !== q)
}

export function suggestHeaderNames(query: string): string[] {
  return rank(COMMON_HEADERS, query).slice(0, 12)
}

export function suggestHeaderValues(headerName: string, query: string): string[] {
  const hints = VALUE_HINTS[headerName.trim().toLowerCase()]
  return hints ? rank(hints, query).slice(0, 12) : []
}
