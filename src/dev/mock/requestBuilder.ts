import type { HttpRequestInput, RequestHeader } from '../../../shared/types'
import { fail } from './util'

export interface BuiltRequest {
  url: string
  headers: RequestHeader[]
  body: BodyInit | undefined
  /** Human-readable body for the /echo route and history. */
  bodyText: string
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? 'file'
const hasHeader = (headers: RequestHeader[], name: string): boolean =>
  headers.some((h) => h.key.toLowerCase() === name.toLowerCase())

function utf8Base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

function placeholderBlob(path: string): Blob {
  return new Blob([`placeholder for ${basename(path)} (browser mock has no file access)`], {
    type: 'application/octet-stream',
  })
}

function withApiKeyQuery(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(key, value)
    return parsed.toString()
  } catch {
    return fail('invalid_input', `Invalid URL: ${url}`)
  }
}

function applyAuth(input: HttpRequestInput, headers: RequestHeader[]): string {
  const { auth } = input
  let url = input.url
  if (auth.kind === 'basic' && auth.basic && !hasHeader(headers, 'authorization')) {
    headers.push({ key: 'Authorization', value: `Basic ${utf8Base64(`${auth.basic.username}:${auth.basic.password}`)}` })
  } else if (auth.kind === 'bearer' && auth.bearer && !hasHeader(headers, 'authorization')) {
    headers.push({ key: 'Authorization', value: `Bearer ${auth.bearer.token}` })
  } else if (auth.kind === 'apiKey' && auth.apiKey?.key) {
    if (auth.apiKey.addTo === 'header') headers.push({ key: auth.apiKey.key, value: auth.apiKey.value })
    else url = withApiKeyQuery(url, auth.apiKey.key, auth.apiKey.value)
  }
  return url
}

function buildBody(input: HttpRequestInput, headers: RequestHeader[]): { body?: BodyInit; text: string } {
  const { body } = input
  switch (body.mode) {
    case 'raw': {
      const raw = body.raw
      if (!raw) return { text: '' }
      if (raw.contentType && !hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: raw.contentType })
      return { body: raw.content, text: raw.content }
    }
    case 'urlEncoded': {
      const params = new URLSearchParams()
      for (const f of body.urlEncoded ?? []) if (f.enabled && f.key) params.append(f.key, f.value)
      if (!hasHeader(headers, 'content-type')) {
        headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })
      }
      return { body: params.toString(), text: params.toString() }
    }
    case 'formData': {
      const form = new FormData()
      const lines: string[] = []
      for (const f of body.formData ?? []) {
        if (!f.enabled || !f.key) continue
        if (f.type === 'file') {
          const path = f.filePath ?? f.value
          form.append(f.key, placeholderBlob(path), basename(path))
          lines.push(`${f.key}=@${basename(path)}`)
        } else {
          form.append(f.key, f.value)
          lines.push(`${f.key}=${f.value}`)
        }
      }
      return { body: form, text: lines.join('\n') }
    }
    case 'binary': {
      const path = body.binaryFilePath ?? ''
      if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: 'application/octet-stream' })
      return { body: placeholderBlob(path), text: `<binary: ${basename(path)}>` }
    }
    default:
      return { text: '' }
  }
}

export function buildRequest(input: HttpRequestInput): BuiltRequest {
  const method = input.method.toUpperCase()
  const headers = input.headers.filter((h) => h.key.trim()).map((h) => ({ ...h }))
  const url = applyAuth(input, headers)
  const { body, text } = buildBody(input, headers)
  const bodyAllowed = method !== 'GET' && method !== 'HEAD'
  return { url, headers, body: bodyAllowed ? body : undefined, bodyText: bodyAllowed ? text : '' }
}
