/** Builders for Postman-v2.1-shaped request documents (the format `documentJson` stores). */
type Json = Record<string, unknown>

export interface Header {
  key: string
  value: string
  disabled?: boolean
}

export interface DocOptions {
  description?: string
  headers?: Header[]
  body?: Json | null
  auth?: Json | null
}

export function makeDoc(name: string, method: string, url: string, opts: DocOptions = {}): string {
  return JSON.stringify({
    name,
    method,
    url,
    description: opts.description ?? null,
    headers: (opts.headers ?? []).map((h) => ({ key: h.key, value: h.value, type: 'text', ...(h.disabled ? { disabled: true } : {}) })),
    body: opts.body ?? null,
    auth: opts.auth ?? null,
  })
}

export const rawBody = (raw: string, language: 'json' | 'xml' | 'text' | 'html' | 'javascript' = 'json'): Json => ({
  mode: 'raw',
  raw,
  options: { raw: { language } },
})

export const urlencodedBody = (fields: Array<[string, string]>): Json => ({
  mode: 'urlencoded',
  urlencoded: fields.map(([key, value]) => ({ key, value, type: 'text' })),
})

export type FormField = { key: string; value: string } | { key: string; src: string }

export const formdataBody = (fields: FormField[]): Json => ({
  mode: 'formdata',
  formdata: fields.map((f) => ('src' in f ? { key: f.key, type: 'file', src: f.src } : { key: f.key, value: f.value, type: 'text' })),
})

export const fileBody = (src: string): Json => ({ mode: 'file', file: { src } })

const attrs = (pairs: Array<[string, string]>) => pairs.map(([key, value]) => ({ key, value, type: 'string' }))

export const bearerAuth = (token: string): Json => ({ type: 'bearer', bearer: attrs([['token', token]]) })
export const basicAuth = (username: string, password: string): Json => ({
  type: 'basic',
  basic: attrs([['username', username], ['password', password]]),
})
export const apiKeyAuth = (key: string, value: string, where: 'header' | 'query'): Json => ({
  type: 'apikey',
  apikey: attrs([['key', key], ['value', value], ['in', where]]),
})
