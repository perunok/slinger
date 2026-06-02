import type { ApiRequest, EnvironmentVariable } from '../tauri'
import {
  type PayloadContentType,
  normalizePayloadContentType,
} from './payloadFormatters'

export type ActiveTab =
  | 'Docs'
  | 'Params'
  | 'Authorization'
  | 'Headers'
  | 'Body'
  | 'Scripts'
  | 'Settings'

export type HeaderDocument = {
  key?: string
  value?: string
  disabled?: boolean
}

export type ResponseExample = {
  name?: string
  status?: string
  code?: number
  body?: string
}

export type ScriptEvent = {
  listen?: string
  script?: {
    exec?: string[] | string
  }
}

export type RequestDocument = {
  method?: string
  url?: string
  description?: string | null
  headers?: HeaderDocument[]
  body?: {
    mode?: string
    raw?: string
  } | null
  auth?: unknown
  scripts?: ScriptEvent[]
  responses?: ResponseExample[]
  source?: {
    request?: {
      url?: {
        variable?: Array<{ key?: string; value?: string; description?: string }>
      }
    }
  }
}

export type RequestParam = {
  key: string
  value: string
  source: string
}

export const REQUEST_TABS: ActiveTab[] = [
  'Docs',
  'Params',
  'Authorization',
  'Headers',
  'Body',
  'Scripts',
  'Settings',
]

export function parseDocument(request: ApiRequest | null): RequestDocument {
  if (!request) return {}

  try {
    return JSON.parse(request.document_json) as RequestDocument
  } catch {
    return {}
  }
}

export function requestHeaders(document: RequestDocument): HeaderDocument[] {
  return Array.isArray(document.headers) ? document.headers : []
}

export function requestResponses(document: RequestDocument): ResponseExample[] {
  return Array.isArray(document.responses) ? document.responses : []
}

export function requestScripts(document: RequestDocument): ScriptEvent[] {
  return Array.isArray(document.scripts) ? document.scripts : []
}

export function extractParams(url: string, document: RequestDocument): RequestParam[] {
  const params: RequestParam[] = []
  const queryIndex = url.indexOf('?')

  if (queryIndex >= 0) {
    const query = url.slice(queryIndex + 1).split('#')[0]
    for (const part of query.split('&')) {
      if (!part) continue
      const [rawKey, rawValue = ''] = part.split('=')
      params.push({
        key: decodeURIComponent(rawKey),
        value: decodeURIComponent(rawValue),
        source: 'query',
      })
    }
  }

  const variables = document.source?.request?.url?.variable
  if (Array.isArray(variables)) {
    for (const variable of variables) {
      if (!variable.key) continue
      params.push({
        key: variable.key,
        value: variable.value ?? '',
        source: 'path',
      })
    }
  }

  return params
}

export function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function scriptText(events: ScriptEvent[]): string {
  const lines: string[] = []

  for (const event of events) {
    const exec = event.script?.exec
    if (!exec) continue
    lines.push(`// ${event.listen ?? 'script'}`)
    lines.push(...(Array.isArray(exec) ? exec : [exec]))
  }

  return lines.join('\n')
}

export type TemplatePart = {
  text: string
  key?: string
  resolved: boolean
  value?: string
}

export function resolveTemplate(value: string, variables: EnvironmentVariable[]): string {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    const variable = variables.find((item) => item.key === key)
    return variable ? variable.value : match
  })
}

export function resolveTemplateParts(value: string, variables: EnvironmentVariable[]): TemplatePart[] {
  const parts: TemplatePart[] = []
  let lastIndex = 0

  for (const match of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    const raw = match[0]
    const key = match[1]
    const index = match.index ?? 0

    if (index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, index), resolved: false })
    }

    const variable = variables.find((item) => item.key === key)
    parts.push({
      text: raw,
      key,
      resolved: Boolean(variable),
      value: variable?.value,
    })

    lastIndex = index + raw.length
  }

  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex), resolved: false })
  }

  return parts
}

export function unresolvedVariables(values: string[]): string[] {
  const names = new Set<string>()

  for (const value of values) {
    for (const match of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      names.add(match[1])
    }
  }

  return [...names]
}

export function payloadContentTypeFromHeaders(
  headers: Array<{ key?: string; value?: string }>,
): PayloadContentType | null {
  const contentType = headers.find(
    (header) => header.key?.toLowerCase() === 'content-type',
  )?.value
  return contentType ? normalizePayloadContentType(contentType) : null
}
