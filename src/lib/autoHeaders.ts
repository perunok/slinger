/** Headers Slinger adds by itself; shown read-only in the Headers tab so nothing is a surprise. */
import { dataRows } from './kv'
import { rawContentType, type RequestDraft } from './request'

export interface AutoHeader {
  key: string
  value: string
  source: string
}

export function autoHeaders(d: RequestDraft): AutoHeader[] {
  const has = (name: string) => dataRows(d.headers).some((h) => h.enabled && h.key.trim().toLowerCase() === name)
  const out: AutoHeader[] = []
  const b = d.body
  if (!has('content-type')) {
    if (b.kind === 'raw') out.push({ key: 'Content-Type', value: rawContentType(b.rawLanguage), source: 'Body (raw)' })
    else if (b.kind === 'urlEncoded') out.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', source: 'Body (urlencoded)' })
    else if (b.kind === 'formData') out.push({ key: 'Content-Type', value: 'multipart/form-data; boundary=<generated>', source: 'Body (form-data)' })
    else if (b.kind === 'binary') out.push({ key: 'Content-Type', value: 'application/octet-stream', source: 'Body (binary)' })
  }
  if (!has('authorization')) {
    if (d.auth.kind === 'basic') out.push({ key: 'Authorization', value: 'Basic <base64(user:password)>', source: 'Authorization tab' })
    else if (d.auth.kind === 'bearer') out.push({ key: 'Authorization', value: 'Bearer <token>', source: 'Authorization tab' })
    else if (d.auth.kind === 'apiKey' && d.auth.apiKey.addTo === 'header' && d.auth.apiKey.key)
      out.push({ key: d.auth.apiKey.key, value: '<value>', source: 'Authorization tab' })
  }
  out.push({ key: 'User-Agent', value: 'Slinger', source: 'Default' })
  return out
}
