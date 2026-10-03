/** Values flowing between workflow nodes: what a response becomes, and how a node's input feeds `{{variables}}`. */
import type { HttpResponseData } from '../../../shared/types'

export interface ResponseValue {
  status: number
  statusText: string
  /** Header names as received; repeated headers joined with ", ". */
  headers: Record<string, string>
  /** Parsed JSON when the body is JSON, else the text; null for a binary body (see `bodyBase64`). */
  body: unknown
  bodyBase64?: string
  durationMs: number
  size: number
  /** Test scripts of the request, when it has any. */
  tests?: { passed: number; failed: number }
}

export function responseValue(r: HttpResponseData, tests?: Array<{ status: string }>): ResponseValue {
  const headers: Record<string, string> = Object.create(null)
  for (const h of r.headers) headers[h.key] = h.key in headers ? `${headers[h.key]}, ${h.value}` : h.value
  let body: unknown = r.bodyText
  if (r.bodyText !== null && r.bodyText.trim()) {
    try {
      body = JSON.parse(r.bodyText)
    } catch {
      /* not JSON: the text */
    }
  }
  const out: ResponseValue = { status: r.status, statusText: r.statusText, headers: { ...headers }, body, durationMs: r.durationMs, size: r.bodyByteLength }
  if (r.bodyText === null && r.bodyBase64 !== null) {
    out.body = null
    out.bodyBase64 = r.bodyBase64
  }
  if (tests && tests.length > 0) {
    const passed = tests.filter((t) => t.status === 'passed').length
    out.tests = { passed, failed: tests.length - passed }
  }
  return out
}

/**
 * The fields of an object input as `{{name}}` variables of the next request (strings as is, anything else as JSON).
 * Anything that is not a plain object gives none (shape it with an Evaluate node first).
 */
export function inputVariables(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key || key.length > 256 || value === undefined) continue
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}

/** Short one-line text of a value for nodes and the run log. */
export function preview(value: unknown, max = 120): string {
  let text: string
  if (value === undefined) text = '—'
  else if (typeof value === 'string') text = JSON.stringify(value)
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Pretty JSON for the inspector (capped so a huge body cannot freeze the page). */
export function pretty(value: unknown, max = 200_000): string {
  if (value === undefined) return ''
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
}
