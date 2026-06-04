import type { ApiRequest, EnvironmentVariable } from '../tauri'
import {
  isBuiltinVariable,
  previewBuiltinVariable,
  resolveBuiltinVariable,
} from './builtinVariables'
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
  description?: unknown
}

export type ResponseExample = {
  id?: string
  name?: string
  originalRequest?: unknown
  responseTime?: string | number | null
  timings?: Record<string, unknown> | null
  cookie?: unknown[]
  status?: string
  code?: number
  header?: HeaderDocument[] | string | null
  body?: string | null
}

export type ScriptEvent = {
  id?: string
  listen?: string
  disabled?: boolean
  script?: {
    type?: string
    exec?: string[] | string
  }
}

export type ScriptListener = 'prerequest' | 'test'

export type RequestScriptState = Record<ScriptListener, string>

const POSTMAN_SCRIPT_LISTENERS = new Set<ScriptListener>(['prerequest', 'test'])

export type RequestDocument = {
  name?: string
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
  if (!Array.isArray(document.headers)) return []

  return document.headers
    .map(sanitizeHeaderDocument)
    .filter((header): header is HeaderDocument => header !== null)
}

export function requestResponses(document: RequestDocument): ResponseExample[] {
  if (!Array.isArray(document.responses)) return []

  return document.responses
    .map(sanitizeResponseExample)
    .filter((response): response is ResponseExample => response !== null)
}

export function normalizeScriptListener(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? ''

  if (normalized === 'pre-request') return 'prerequest'
  if (normalized === 'post-request') return 'test'

  return normalized
}

export function sanitizeScriptEvent(event: ScriptEvent): ScriptEvent | null {
  const listener = normalizeScriptListener(event.listen)
  if (!POSTMAN_SCRIPT_LISTENERS.has(listener as ScriptListener)) return null

  const nextEvent: ScriptEvent & { id?: string; disabled?: boolean } = {
    ...event,
    listen: listener,
    disabled: Boolean(event.disabled),
  }

  if (event.script) {
    const exec = Array.isArray(event.script.exec)
      ? event.script.exec.map((line) => String(line))
      : typeof event.script.exec === 'string'
        ? event.script.exec
        : undefined
    nextEvent.script = {
      ...event.script,
      type: event.script.type?.trim() || 'text/javascript',
      exec,
    }
  }

  return nextEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function headerFromString(value: string): HeaderDocument {
  const separatorIndex = value.indexOf(':')
  if (separatorIndex < 0) {
    return {
      key: value.trim(),
      value: '',
    }
  }

  return {
    key: value.slice(0, separatorIndex).trim(),
    value: value.slice(separatorIndex + 1).trim(),
  }
}

export function sanitizeHeaderDocument(header: unknown): HeaderDocument | null {
  if (typeof header === 'string') {
    const parsed = headerFromString(header)
    return parsed.key ? parsed : null
  }

  if (!isRecord(header)) return null

  const key =
    typeof header.key === 'string'
      ? header.key.trim()
      : header.key === undefined || header.key === null
        ? ''
        : String(header.key)
  if (!key) return null

  const value =
    typeof header.value === 'string'
      ? header.value
      : header.value === undefined || header.value === null
        ? ''
        : String(header.value)

  return {
    ...header,
    key,
    value,
    disabled: Boolean(header.disabled),
  }
}

function sanitizeResponseHeaders(headers: unknown): HeaderDocument[] | string | null {
  if (headers === null || headers === undefined) return null
  if (typeof headers === 'string') {
    const normalized = headers
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(sanitizeHeaderDocument)
      .filter((header): header is HeaderDocument => header !== null)

    return normalized.length > 0 ? normalized : headers
  }
  if (!Array.isArray(headers)) return null

  return headers
    .map(sanitizeHeaderDocument)
    .filter((header): header is HeaderDocument => header !== null)
}

export function sanitizeResponseExample(response: unknown): ResponseExample | null {
  if (!isRecord(response)) return null

  const codeValue = response.code
  const code =
    typeof codeValue === 'number'
      ? Number.isFinite(codeValue)
        ? Math.trunc(codeValue)
        : undefined
      : typeof codeValue === 'string' && codeValue.trim()
        ? Number.parseInt(codeValue, 10)
        : undefined
  const status =
    typeof response.status === 'string'
      ? response.status
      : code !== undefined
        ? String(code)
        : undefined
  const body =
    typeof response.body === 'string'
      ? response.body
      : response.body === null || response.body === undefined
        ? null
        : String(response.body)

  return {
    ...response,
    id: typeof response.id === 'string' ? response.id : undefined,
    name: typeof response.name === 'string' ? response.name : undefined,
    status,
    code: Number.isNaN(code ?? NaN) ? undefined : code,
    header: sanitizeResponseHeaders(response.header),
    body,
    responseTime:
      response.responseTime === null ||
      typeof response.responseTime === 'string' ||
      typeof response.responseTime === 'number'
        ? (response.responseTime as string | number | null | undefined)
        : undefined,
    timings: isRecord(response.timings) || response.timings === null
      ? (response.timings as Record<string, unknown> | null | undefined)
      : undefined,
    cookie: Array.isArray(response.cookie) ? response.cookie : undefined,
    originalRequest: response.originalRequest,
  }
}

export function requestScripts(document: RequestDocument): ScriptEvent[] {
  if (!Array.isArray(document.scripts)) return []

  return document.scripts
    .filter((event): event is ScriptEvent => Boolean(event && typeof event === 'object'))
    .map(sanitizeScriptEvent)
    .filter((event): event is ScriptEvent => event !== null)
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

export function scriptEventText(event: ScriptEvent): string {
  const exec = event.script?.exec
  if (!exec) return ''

  return Array.isArray(exec) ? exec.join('\n') : exec
}

export function scriptTextForListener(events: ScriptEvent[], listener: ScriptListener): string {
  const normalizedListener = normalizeScriptListener(listener)

  return events
    .filter((event) => normalizeScriptListener(event.listen) === normalizedListener)
    .map(scriptEventText)
    .filter(Boolean)
    .join('\n\n')
}

export function requestScriptState(document: RequestDocument): RequestScriptState {
  const events = requestScripts(document)

  return {
    prerequest: scriptTextForListener(events, 'prerequest'),
    test: scriptTextForListener(events, 'test'),
  }
}

export function updateScriptListener(
  events: ScriptEvent[],
  listener: ScriptListener,
  value: string,
): ScriptEvent[] {
  const normalizedListener = normalizeScriptListener(listener)
  const hasContent = value.trim().length > 0
  const nextScript = hasContent
    ? {
        listen: normalizedListener,
        script: {
          type: 'text/javascript',
          exec: value.split('\n'),
        },
      }
    : null
  const nextEvents: ScriptEvent[] = []
  let inserted = false

  for (const event of events) {
    if (normalizeScriptListener(event.listen) !== normalizedListener) {
      nextEvents.push(event)
      continue
    }

    if (!inserted && nextScript) {
      nextEvents.push({
        ...event,
        ...nextScript,
        script: {
          ...(event.script ?? {}),
          ...(nextScript.script ?? {}),
        },
      })
      inserted = true
    }
  }

  if (!inserted && nextScript) {
    return listener === 'prerequest' ? [nextScript, ...nextEvents] : [...nextEvents, nextScript]
  }

  return nextEvents
}

export function scriptEventsEqual(left: ScriptEvent[], right: ScriptEvent[]): boolean {
  const comparable = (events: ScriptEvent[]) =>
    events.map((event) => ({
      listen: normalizeScriptListener(event.listen) || event.listen?.trim() || '',
      type: event.script?.type?.trim() || '',
      exec: scriptEventText(event),
    }))

  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

export type TemplatePart = {
  text: string
  key?: string
  resolved: boolean
  source?: 'environment' | 'builtin' | 'unresolved'
  value?: string
}

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g

export function resolveTemplate(value: string, variables: EnvironmentVariable[], now = new Date()): string {
  return value.replace(TEMPLATE_VARIABLE_PATTERN, (match, key: string) => {
    const variable = variables.find((item) => item.key === key)
    if (variable) return variable.value

    return resolveBuiltinVariable(key, now) ?? match
  })
}

export function resolveTemplateParts(value: string, variables: EnvironmentVariable[]): TemplatePart[] {
  const parts: TemplatePart[] = []
  let lastIndex = 0

  for (const match of value.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const raw = match[0]
    const key = match[1]
    const index = match.index ?? 0

    if (index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, index), resolved: false })
    }

    const variable = variables.find((item) => item.key === key)
    const builtinValue = variable ? null : previewBuiltinVariable(key)
    parts.push({
      text: raw,
      key,
      resolved: Boolean(variable || builtinValue !== null),
      source: variable ? 'environment' : builtinValue !== null ? 'builtin' : 'unresolved',
      value: variable?.value ?? builtinValue ?? undefined,
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
    for (const match of value.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
      if (!isBuiltinVariable(match[1])) names.add(match[1])
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
