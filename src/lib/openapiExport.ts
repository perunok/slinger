/**
 * A collection as an OpenAPI 3.1 document (Export dialog, "OpenAPI 3.1"). Pure functions, no DOM, no IPC.
 *
 * Each saved HTTP request becomes an operation: the URL is split into a server (`{{baseUrl}}` -> the collection
 * variable's value; other `{{vars}}` in the host part -> server variables; an absolute URL -> its scheme + host) and a
 * path (`:id` and `{{id}}` segments -> `{id}` path parameters). Query, header and cookie rows become parameters, the body
 * a requestBody, and saved examples the responses, with JSON Schemas inferred from their JSON (schemaInfer.ts). Auth
 * becomes `components.securitySchemes` + `security` (document-wide when every operation uses the same).
 *
 * Requests with the same method + path are one operation in OpenAPI: the first request defines it, later ones add their
 * parameters and examples, and their names are listed in the description. MCP requests and methods without an OpenAPI
 * field (anything but GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH, TRACE) are left out and counted.
 *
 * Requests imported from an OpenAPI document (document key `openapi`, `{key, operationId, specHash, itemHash}`) keep
 * their `operationId`, a " (deprecated)" name suffix becomes `deprecated: true`, and their parameters that the import
 * enabled (the spec's required ones) are `required: true` again. Scripts, tests, versions and secrets are never part of
 * the document: `{{variables}}` stay as written, only server and OAuth URLs use the collection variables' values.
 */
import { dump } from 'js-yaml'
import type { ApiFolder, ApiRequest, Collection, CollectionVariable } from '../../shared/types'
import { mimeForLanguage, parseExample } from './examples'
import { dataRows, type KvRow } from './kv'
import { parseDocument, rawContentType, type AuthDraft, type BodyDraft, type RequestDraft } from './request'
import { inferSchema, mergeSchemas, stringFormat, type JsonSchema } from './schemaInfer'
import { buildTree, type TreeNode } from './tree'

export const OPENAPI_VERSION = '3.1.0'

export interface OpenApiServerVariable {
  default: string
  description?: string
}

export interface OpenApiServer {
  url: string
  description?: string
  variables?: Record<string, OpenApiServerVariable>
}

export type ParameterLocation = 'query' | 'header' | 'path' | 'cookie'

export interface OpenApiParameter {
  name: string
  in: ParameterLocation
  required: boolean
  description?: string
  schema: JsonSchema
  example?: unknown
}

export interface OpenApiExample {
  summary?: string
  value: unknown
}

export interface OpenApiMediaType {
  schema: JsonSchema
  example?: unknown
  examples?: Record<string, OpenApiExample>
}

export interface OpenApiRequestBody {
  required?: boolean
  content: Record<string, OpenApiMediaType>
}

export interface OpenApiResponse {
  description: string
  content?: Record<string, OpenApiMediaType>
}

/** `{schemeName: scopes}`; scopes only matter for OAuth 2.0. */
export type SecurityRequirement = Record<string, string[]>

export interface OpenApiOperation {
  tags?: string[]
  summary: string
  description?: string
  operationId: string
  deprecated?: boolean
  servers?: OpenApiServer[]
  parameters?: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  responses: Record<string, OpenApiResponse>
  security?: SecurityRequirement[]
}

export interface OpenApiTag {
  name: string
  description?: string
}

export interface OpenApiDocument {
  openapi: typeof OPENAPI_VERSION
  info: { title: string; version: string; description?: string }
  servers?: OpenApiServer[]
  tags?: OpenApiTag[]
  security?: SecurityRequirement[]
  paths: Record<string, Record<string, OpenApiOperation>>
  components?: { securitySchemes?: Record<string, JsonSchema> }
}

export interface OpenApiExportInput {
  collection: Pick<Collection, 'name'> & Partial<Pick<Collection, 'description'>>
  folders: ApiFolder[]
  requests: ApiRequest[]
  /** Collection variables: `baseUrl` gives the server, others the defaults of server variables and OAuth URLs. */
  variables?: ReadonlyArray<Pick<CollectionVariable, 'key' | 'value' | 'enabled'>> | null
  /** The collection's latest version, written to `info.version` ("1.0.0" when none). */
  latestVersion?: string | null
}

export interface OpenApiExport {
  document: OpenApiDocument
  /** MCP requests left out (OpenAPI describes HTTP APIs). */
  skippedMcp: number
  /** HTTP requests left out because OpenAPI 3.1 has no field for their method (e.g. PROPFIND). */
  skippedMethods: number
}

/** Path item fields for operations in OpenAPI 3.1. */
const OPERATION_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
/** OpenAPI ignores header parameters with these names: they are described by requestBody, responses and security. */
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization'])

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const hasTemplate = (s: string) => /\{\{[^{}]*\}\}/.test(s)
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A parameter / form value as a typed example and its schema (`{{templates}}` and empty values: no example). */
function typedValue(value: string): { schema: JsonSchema; example?: unknown } {
  if (value === '' || hasTemplate(value)) return { schema: { type: 'string' } }
  if (/^-?(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) return { schema: { type: 'integer' }, example: Number(value) }
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(value)) return { schema: { type: 'number' }, example: Number(value) }
  if (value === 'true' || value === 'false') return { schema: { type: 'boolean' }, example: value === 'true' }
  const format = stringFormat(value)
  return { schema: format ? { type: 'string', format } : { type: 'string' }, example: value }
}

/** `{{name}}` -> the enabled collection variable's value (unknown names stay as written). */
function resolveVars(text: string, vars: Map<string, string>): string {
  return text.replace(TEMPLATE, (whole, name: string) => vars.get(name) ?? whole)
}

const mediaType = (contentType: string) => contentType.split(';')[0]!.trim().toLowerCase()
const isJsonMedia = (mt: string) => mt === 'application/json' || mt.endsWith('+json') || mt === 'text/json'
const isTextMedia = (mt: string) => isJsonMedia(mt) || mt.startsWith('text/') || mt.endsWith('+xml') || mt === 'application/xml' || mt === 'application/javascript'

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** Stands for an unquoted `{{variable}}` while a JSON body is parsed. */
const UNKNOWN = '\u0000slinger:unknown'

function unknownToUndefined(v: unknown): unknown {
  if (v === UNKNOWN) return undefined
  if (Array.isArray(v)) return v.map(unknownToUndefined)
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unknownToUndefined(x)]))
  return v
}

function headerValue(rows: KvRow[], name: string): string | null {
  const row = dataRows(rows).find((r) => r.enabled && r.key.trim().toLowerCase() === name)
  return row ? row.value : null
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

interface UrlTarget {
  server: OpenApiServer | null
  path: string
  /** Path template names in order of appearance. */
  pathParams: string[]
}

/** `{{x}}` in a server URL -> `{x}` plus a server variable whose default is the collection variable's value. */
function serverTemplate(text: string, vars: Map<string, string>): OpenApiServer {
  const variables: Record<string, OpenApiServerVariable> = {}
  const url = text.replace(TEMPLATE, (_whole, name: string) => {
    variables[name] = { default: vars.get(name) ?? '' }
    return `{${name}}`
  })
  const trimmed = url.length > 1 ? url.replace(/\/+$/, '') || '/' : url
  return Object.keys(variables).length > 0 ? { url: trimmed, variables } : { url: trimmed }
}

function baseUrlServer(vars: Map<string, string>): OpenApiServer {
  const value = vars.get('baseUrl')
  if (value === undefined || value.trim() === '') {
    return { url: '{baseUrl}', variables: { baseUrl: { default: '', description: 'The collection has no baseUrl value.' } } }
  }
  // baseUrl's own value may use other variables (`https://{{region}}.api.test`); never itself.
  return serverTemplate(value.trim().replace(/\{\{\s*baseUrl\s*\}\}/g, ''), vars)
}

const looksLikeHost = (segment: string) => segment.includes('.') || segment.includes(':') || segment.includes('{{') || segment === 'localhost'

/** Path text -> OpenAPI path template: `:id` / `{{id}}` segments become `{id}`. */
function pathTemplate(rawPath: string): { path: string; pathParams: string[] } {
  const segments = rawPath.split('/').map((seg) => {
    const colon = /^:([A-Za-z0-9_.$-]+)$/.exec(seg)
    if (colon) return `{${colon[1]}}`
    return seg.replace(TEMPLATE, (_whole, name: string) => `{${name}}`)
  })
  let path = segments.join('/')
  if (!path.startsWith('/')) path = `/${path}`
  const pathParams: string[] = []
  for (const m of path.matchAll(/\{([^{}]+)\}/g)) if (!pathParams.includes(m[1]!)) pathParams.push(m[1]!)
  return { path, pathParams }
}

/** Splits a request URL (templates kept) into its server and path template. */
export function splitRequestUrl(url: string, vars: Map<string, string> = new Map()): UrlTarget {
  let rest = url.trim()
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)

  let server: OpenApiServer | null = null
  let rawPath = rest
  const lead = /^\{\{\s*([^{}]*?)\s*\}\}/.exec(rest)
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rest)
  if (lead && (rest.length === lead[0].length || rest[lead[0].length] === '/')) {
    // `{{baseUrl}}/pets` (or any variable standing for the whole origin, `{{host}}/pets`).
    server = lead[1] === 'baseUrl' ? baseUrlServer(vars) : serverTemplate(lead[0], vars)
    rawPath = rest.slice(lead[0].length)
  } else if (scheme) {
    const afterScheme = rest.slice(scheme[0].length)
    const slash = afterScheme.indexOf('/')
    const authority = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme
    server = serverTemplate(`${scheme[0]}${authority}`, vars)
    rawPath = slash >= 0 ? afterScheme.slice(slash) : ''
  } else if (!rest.startsWith('/')) {
    const slash = rest.indexOf('/')
    const first = slash >= 0 ? rest.slice(0, slash) : rest
    if (looksLikeHost(first)) {
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(first)
      server = serverTemplate(`${local ? 'http' : 'https'}://${first}`, vars)
      rawPath = slash >= 0 ? rest.slice(slash) : ''
    }
  }
  return { server, ...pathTemplate(rawPath) }
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

interface SecurityUse {
  base: string
  scheme: JsonSchema
  scopes: string[]
}

function oauth2Use(auth: AuthDraft, vars: Map<string, string>): SecurityUse | null {
  const o = auth.oauth2
  const scopes = o.scope.split(/[\s,]+/).filter(Boolean)
  const scopeMap: Record<string, string> = {}
  for (const s of scopes) scopeMap[s] = ''
  const url = (s: string) => resolveVars(s.trim(), vars)
  const refresh = o.refreshTokenUrl.trim() ? { refreshUrl: url(o.refreshTokenUrl) } : {}
  let flows: Json
  switch (o.grantType) {
    case 'authorization_code':
    case 'authorization_code_with_pkce':
      flows = { authorizationCode: { authorizationUrl: url(o.authUrl), tokenUrl: url(o.accessTokenUrl), ...refresh, scopes: scopeMap } }
      break
    case 'client_credentials':
      flows = { clientCredentials: { tokenUrl: url(o.accessTokenUrl), ...refresh, scopes: scopeMap } }
      break
    case 'password':
      flows = { password: { tokenUrl: url(o.accessTokenUrl), ...refresh, scopes: scopeMap } }
      break
    case 'implicit':
      flows = { implicit: { authorizationUrl: url(o.authUrl), ...refresh, scopes: scopeMap } }
      break
    default:
      return null
  }
  return { base: 'oauth2', scheme: { type: 'oauth2', flows }, scopes }
}

function securityUse(auth: AuthDraft, vars: Map<string, string>): SecurityUse | null {
  switch (auth.kind) {
    case 'bearer':
      return { base: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' }, scopes: [] }
    case 'basic':
      return { base: 'basicAuth', scheme: { type: 'http', scheme: 'basic' }, scopes: [] }
    case 'apiKey': {
      const name = resolveVars(auth.apiKey.key.trim(), vars) || 'X-API-Key'
      return { base: 'apiKeyAuth', scheme: { type: 'apiKey', in: auth.apiKey.addTo, name }, scopes: [] }
    }
    case 'oauth2':
      return oauth2Use(auth, vars)
    case 'unsupported':
      return auth.unsupportedType === 'digest' ? { base: 'digestAuth', scheme: { type: 'http', scheme: 'digest' }, scopes: [] } : null
    default:
      return null
  }
}

/** Security scheme names: one per distinct scheme, `bearerAuth`, `apiKeyAuth`, `apiKeyAuth_2`, ... */
class SchemeRegistry {
  readonly schemes = new Map<string, JsonSchema>()

  register(use: SecurityUse): string {
    const json = JSON.stringify(use.scheme)
    for (const [name, scheme] of this.schemes) if (JSON.stringify(scheme) === json) return name
    let name = use.base
    for (let n = 2; this.schemes.has(name); n++) name = `${use.base}_${n}`
    this.schemes.set(name, use.scheme)
    return name
  }
}

// ---------------------------------------------------------------------------
// Operations (accumulated, so requests with the same method + path merge)
// ---------------------------------------------------------------------------

interface ExampleAcc {
  name: string
  value?: unknown
}

interface MediaAcc {
  schema: JsonSchema | null
  examples: ExampleAcc[]
}

interface ResponseAcc {
  description: string
  content: Map<string, MediaAcc>
}

interface OperationAcc {
  method: string
  path: string
  names: string[]
  summary: string
  description: string
  specOperationId: string | null
  deprecated: boolean
  tags: string[]
  server: OpenApiServer | null
  params: Map<string, OpenApiParameter>
  body: { required: boolean; content: Map<string, MediaAcc> } | null
  responses: Map<string, ResponseAcc>
  security: SecurityRequirement[] | null
}

function addMedia(content: Map<string, MediaAcc>, mt: string, schema: JsonSchema | null, example: ExampleAcc | null): void {
  const acc = content.get(mt)
  if (!acc) {
    content.set(mt, { schema, examples: example ? [example] : [] })
    return
  }
  acc.schema = acc.schema && schema ? mergeSchemas(acc.schema, schema) : (acc.schema ?? schema)
  if (example) acc.examples.push(example)
}

/** Postman source item of an imported request (`source.request`), for what the import knew about each row. */
function sourceRequest(extras: Record<string, unknown>): Json | null {
  return isObj(extras.source) && isObj(extras.source.request) ? extras.source.request : null
}

/** Keys of the rows the import enabled. From an OpenAPI import those are the spec's required parameters. */
function enabledSourceKeys(list: unknown, lower = false): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(list)) return out
  for (const row of list) {
    if (isObj(row) && typeof row.key === 'string' && !row.disabled) out.add(lower ? row.key.toLowerCase() : row.key)
  }
  return out
}

function parameter(name: string, where: ParameterLocation, required: boolean, values: string[], description: string): OpenApiParameter {
  const typed = values.map(typedValue)
  let schema: JsonSchema
  let example: unknown
  if (typed.length > 1) {
    // A repeated query key (`?tag=a&tag=b`) is an array, sent exploded (OpenAPI's default for query).
    schema = { type: 'array', items: typed.map((t) => t.schema).reduce(mergeSchemas) }
    if (typed.every((t) => 'example' in t)) example = typed.map((t) => t.example)
  } else {
    schema = typed[0]?.schema ?? { type: 'string' }
    if (typed[0] && 'example' in typed[0]) example = typed[0].example
  }
  const p = { name, in: where, required } as OpenApiParameter
  if (description.trim()) p.description = description.trim()
  p.schema = schema
  if (example !== undefined) p.example = example
  return p
}

function parametersOf(draft: RequestDraft, pathParams: string[], fromSpec: boolean): OpenApiParameter[] {
  const out: OpenApiParameter[] = []
  const source = sourceRequest(draft.extras)
  const sourceUrl = source && isObj(source.url) ? source.url : null

  // Path: the request's path variables (Postman `url.variable`) carry values and descriptions; then the imported item's.
  const pathVars = new Map<string, Json>()
  for (const v of draft.pathVariables) if (!pathVars.has(v.key)) pathVars.set(v.key, { key: v.key, value: v.value, description: v.description })
  if (sourceUrl && Array.isArray(sourceUrl.variable)) {
    for (const v of sourceUrl.variable) if (isObj(v) && typeof v.key === 'string' && !pathVars.has(v.key)) pathVars.set(v.key, v)
  }
  for (const name of pathParams) {
    const v = pathVars.get(name)
    const value = v && typeof v.value === 'string' ? v.value : v && typeof v.value === 'number' ? String(v.value) : ''
    const description = v ? readText(v.description) : ''
    out.push(parameter(name, 'path', true, value ? [value] : [], description))
  }

  // Query: one parameter per key; enabled rows are required only when an OpenAPI import enabled them.
  const requiredQuery = fromSpec ? enabledSourceKeys(sourceUrl?.query) : new Set<string>()
  const query = new Map<string, KvRow[]>()
  for (const r of dataRows(draft.params)) {
    if (!r.key) continue
    query.set(r.key, [...(query.get(r.key) ?? []), r])
  }
  for (const [key, rows] of query) {
    const enabled = rows.some((r) => r.enabled)
    const description = rows.find((r) => r.description)?.description ?? ''
    out.push(parameter(key, 'query', enabled && requiredQuery.has(key), rows.map((r) => r.value), description))
  }

  // Headers (Accept, Content-Type and Authorization are described elsewhere); a Cookie header -> cookie parameters.
  const requiredHeaders = fromSpec ? enabledSourceKeys(source?.header, true) : new Set<string>()
  const seen = new Set<string>()
  for (const r of dataRows(draft.headers)) {
    const key = r.key.trim()
    const lower = key.toLowerCase()
    if (!key || RESERVED_HEADERS.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    const required = r.enabled && requiredHeaders.has(lower)
    if (lower === 'cookie') {
      for (const part of r.value.split(';')) {
        const eq = part.indexOf('=')
        const name = (eq >= 0 ? part.slice(0, eq) : part).trim()
        if (name) out.push(parameter(name, 'cookie', required, eq >= 0 ? [part.slice(eq + 1).trim()] : [], ''))
      }
      continue
    }
    out.push(parameter(key, 'header', required, [r.value], r.description))
  }
  return out
}

function readText(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObj(v) && typeof v.content === 'string') return v.content
  return ''
}

function formMedia(rows: KvRow[], withFiles: boolean, fromSpec: boolean): MediaAcc {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const example: Json = {}
  for (const r of dataRows(rows)) {
    if (!r.key || r.key in properties) continue
    const file = withFiles && r.kind === 'file'
    const prop: JsonSchema = file ? { type: 'string', format: 'binary' } : { type: 'string' }
    if (r.description.trim()) prop.description = r.description.trim()
    properties[r.key] = prop
    if (fromSpec && r.enabled) required.push(r.key)
    if (!file && r.value !== '' && !hasTemplate(r.value)) example[r.key] = r.value
  }
  const schema: JsonSchema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return { schema, examples: Object.keys(example).length > 0 ? [{ name: 'Example', value: example }] : [] }
}

function requestBodyOf(body: BodyDraft, headers: KvRow[], fromSpec: boolean): { mt: string; media: MediaAcc } | null {
  const declared = headerValue(headers, 'content-type')
  const declaredMt = declared && !hasTemplate(declared) ? mediaType(declared) : ''
  switch (body.kind) {
    case 'raw': {
      if (body.raw.trim() === '') return null
      const mt = declaredMt || rawContentType(body.rawLanguage)
      if (isJsonMedia(mt) || body.rawLanguage === 'json') {
        const parsed = parseJson(body.raw)
        if (parsed.ok) return { mt, media: { schema: inferSchema(parsed.value), examples: [{ name: 'Example', value: parsed.value }] } }
        // `{"id": {{id}}}`: the shape, with the variables' values unknown (`{}`), and no example.
        const filled = parseJson(body.raw.replace(/(?<!")\{\{[^{}]*\}\}(?!")/g, JSON.stringify(UNKNOWN)))
        return { mt, media: { schema: filled.ok ? inferSchema(unknownToUndefined(filled.value)) : {}, examples: [] } }
      }
      return { mt, media: { schema: { type: 'string' }, examples: [{ name: 'Example', value: body.raw }] } }
    }
    case 'urlEncoded':
      return { mt: 'application/x-www-form-urlencoded', media: formMedia(body.urlEncoded, false, fromSpec) }
    case 'formData':
      return { mt: 'multipart/form-data', media: formMedia(body.formData, true, fromSpec) }
    case 'binary':
      return { mt: declaredMt || 'application/octet-stream', media: { schema: { type: 'string', format: 'binary' }, examples: [] } }
    case 'unsupported': {
      const b = body.preserved
      if (!isObj(b) || b.mode !== 'graphql' || !isObj(b.graphql)) return null
      const query = typeof b.graphql.query === 'string' ? b.graphql.query : ''
      const vars = typeof b.graphql.variables === 'string' ? parseJson(b.graphql.variables) : { ok: false as const }
      const value: Json = { query }
      if (vars.ok) value.variables = vars.value
      return {
        mt: 'application/json',
        media: { schema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'] }, examples: [{ name: 'Example', value }] },
      }
    }
    default:
      return null
  }
}

/**
 * The response key and description of an example. An OpenAPI import names examples `${key} ${description}` and sends
 * `default` / `4XX` as 500 / 400, so for such requests the name gives the original key back.
 */
function responseKeyOf(code: number | null, name: string, fromSpec: boolean): { key: string; description: string } {
  if (fromSpec) {
    const m = /^(default|[1-5]XX|[1-5]\d\d)(?: (.*))?$/i.exec(name)
    if (m && (m[1]!.length !== 3 || /\D/.test(m[1]!) || Number(m[1]) === code)) {
      const key = /^default$/i.test(m[1]!) ? 'default' : m[1]!.toUpperCase()
      return { key, description: m[2]?.trim() || name }
    }
  }
  return { key: code !== null ? String(code) : 'default', description: name }
}

function addResponses(op: OperationAcc, request: ApiRequest, responses: unknown[], fromSpec: boolean): void {
  for (const raw of responses) {
    const { response } = parseExample(raw, request)
    const name = response.name.trim() || response.status.trim() || 'Response'
    const { key, description } = responseKeyOf(response.code, name, fromSpec)
    let acc = op.responses.get(key)
    if (!acc) {
      acc = { description, content: new Map() }
      op.responses.set(key, acc)
    }
    const declared = headerValue(response.headers, 'content-type')
    let mt = declared ? mediaType(declared) : mimeForLanguage(response.language)
    const body = response.body
    if (response.bodyEncoding === 'base64') {
      addMedia(acc.content, mt || 'application/octet-stream', { type: 'string', format: 'binary' }, null)
      continue
    }
    if (body.trim() === '') {
      // An empty example (204, or a binary response imported from a spec): only the content type is known.
      if (mt) addMedia(acc.content, mt, isTextMedia(mt) ? null : { type: 'string', format: 'binary' }, null)
      continue
    }
    const parsed = parseJson(body)
    if (!mt) mt = parsed.ok ? 'application/json' : 'text/plain'
    if (isJsonMedia(mt) && parsed.ok) addMedia(acc.content, mt, inferSchema(parsed.value), { name, value: parsed.value })
    else addMedia(acc.content, mt, { type: 'string' }, { name, value: body })
  }
}

function mergeContent(into: Map<string, MediaAcc>, from: Map<string, MediaAcc>): void {
  for (const [mt, media] of from) {
    addMedia(into, mt, media.schema, null)
    into.get(mt)!.examples.push(...media.examples)
  }
}

function mergeInto(op: OperationAcc, other: OperationAcc): void {
  op.names.push(...other.names)
  for (const t of other.tags) if (!op.tags.includes(t)) op.tags.push(t)
  for (const [k, p] of other.params) if (!op.params.has(k)) op.params.set(k, p)
  if (!op.body) op.body = other.body
  else if (other.body) mergeContent(op.body.content, other.body.content)
  for (const [key, r] of other.responses) {
    const mine = op.responses.get(key)
    if (mine) mergeContent(mine.content, r.content)
    else op.responses.set(key, r)
  }
  if (!op.security) op.security = other.security
  if (!op.specOperationId) op.specOperationId = other.specOperationId
}

// ---------------------------------------------------------------------------
// Operation ids
// ---------------------------------------------------------------------------

function camelWords(words: string[]): string {
  return words
    .map((w, i) => {
      const word = w.length > 1 && w === w.toUpperCase() ? w.toLowerCase() : w
      return i === 0 ? word[0]!.toLowerCase() + word.slice(1) : word[0]!.toUpperCase() + word.slice(1)
    })
    .join('')
}

/** "List pets" -> `listPets`; names without ASCII letters fall back to method + path (`getPetsPetId`). */
export function operationIdFromName(name: string, method: string, path: string): string {
  let id = camelWords(name.split(/[^A-Za-z0-9]+/).filter(Boolean))
  if (!/[A-Za-z]/.test(id)) id = camelWords([method.toLowerCase(), ...path.split(/[^A-Za-z0-9]+/).filter(Boolean)])
  if (/^\d/.test(id)) id = `op${id}`
  return id || 'operation'
}

function assignOperationIds(ops: OperationAcc[]): string[] {
  const taken = new Set<string>()
  const ids: (string | null)[] = ops.map(() => null)
  // Ids an OpenAPI import kept win over generated ones.
  ops.forEach((op, i) => {
    if (op.specOperationId && !taken.has(op.specOperationId)) {
      taken.add(op.specOperationId)
      ids[i] = op.specOperationId
    }
  })
  return ops.map((op, i) => {
    if (ids[i]) return ids[i]!
    const base = op.specOperationId ?? operationIdFromName(op.summary, op.method, op.path)
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`
    taken.add(id)
    return id
  })
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function exampleKey(name: string, used: Set<string>): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'example'
  let key = base
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`
  used.add(key)
  return key
}

function finishMedia(media: MediaAcc): OpenApiMediaType {
  const out: OpenApiMediaType = { schema: media.schema ?? {} }
  const withValue = media.examples.filter((e) => 'value' in e)
  if (withValue.length === 1) out.example = withValue[0]!.value
  else if (withValue.length > 1) {
    const used = new Set<string>()
    const examples: Record<string, OpenApiExample> = {}
    for (const e of withValue) examples[exampleKey(e.name, used)] = { summary: e.name, value: e.value }
    out.examples = examples
  }
  return out
}

function finishContent(content: Map<string, MediaAcc>): Record<string, OpenApiMediaType> {
  const out: Record<string, OpenApiMediaType> = {}
  for (const [mt, media] of content) out[mt] = finishMedia(media)
  return out
}

const sameServer = (a: OpenApiServer | null, b: OpenApiServer | null) => JSON.stringify(a) === JSON.stringify(b)

/** The OpenAPI 3.1 document for a collection, plus what was left out. */
export function buildOpenApiExport({ collection, folders, requests, variables, latestVersion }: OpenApiExportInput): OpenApiExport {
  const vars = new Map<string, string>()
  for (const v of variables ?? []) if (v.enabled && !vars.has(v.key)) vars.set(v.key, v.value)

  const registry = new SchemeRegistry()
  const ops: OperationAcc[] = []
  const byKey = new Map<string, OperationAcc>()
  const tagOrder: OpenApiTag[] = []
  let skippedMcp = 0
  let skippedMethods = 0

  const visit = (request: ApiRequest, topFolder: ApiFolder | null) => {
    const draft = parseDocument(request)
    if (draft.mcp) {
      skippedMcp++
      return
    }
    const method = draft.method.toLowerCase()
    if (!OPERATION_METHODS.has(method)) {
      skippedMethods++
      return
    }
    const meta = isObj(draft.extras.openapi) ? draft.extras.openapi : null
    const fromSpec = meta !== null
    const target = splitRequestUrl(draft.url, vars)
    const deprecated = fromSpec && / \(deprecated\)$/.test(request.name)
    const summary = (deprecated ? request.name.replace(/ \(deprecated\)$/, '') : request.name).trim() || `${draft.method} ${target.path}`

    const op: OperationAcc = {
      method,
      path: target.path,
      names: [request.name],
      summary,
      description: draft.description.trim(),
      specOperationId: meta && typeof meta.operationId === 'string' && meta.operationId.trim() ? meta.operationId.trim() : null,
      deprecated,
      tags: [],
      server: target.server,
      params: new Map(),
      body: null,
      responses: new Map(),
      security: null,
    }
    if (topFolder) {
      op.tags.push(topFolder.name)
      if (!tagOrder.some((t) => t.name === topFolder.name)) {
        const tag: OpenApiTag = { name: topFolder.name }
        if (topFolder.description?.trim()) tag.description = topFolder.description.trim()
        tagOrder.push(tag)
      }
    }
    for (const p of parametersOf(draft, target.pathParams, fromSpec)) {
      const k = `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`
      if (!op.params.has(k)) op.params.set(k, p)
    }
    const body = requestBodyOf(draft.body, draft.headers, fromSpec)
    if (body) {
      op.body = { required: true, content: new Map([[body.mt, body.media]]) }
    }
    const responses = Array.isArray(draft.extras.responses) ? draft.extras.responses : []
    addResponses(op, request, responses, fromSpec)
    const use = securityUse(draft.auth, vars)
    if (use) op.security = [{ [registry.register(use)]: use.scopes }]

    const key = `${method} ${op.path}`
    const existing = byKey.get(key)
    if (existing) mergeInto(existing, op)
    else {
      byKey.set(key, op)
      ops.push(op)
    }
  }

  const walk = (nodes: TreeNode[], top: ApiFolder | null) => {
    for (const n of nodes) {
      if (n.kind === 'folder') walk(n.children, top ?? n.folder)
      else visit(n.request, top)
    }
  }
  walk(buildTree(folders, requests), null)

  // Servers: the most used one for the document; operations elsewhere name theirs.
  const counts: { server: OpenApiServer; count: number }[] = []
  for (const op of ops) {
    if (!op.server) continue
    const hit = counts.find((c) => sameServer(c.server, op.server))
    if (hit) hit.count++
    else counts.push({ server: op.server, count: 1 })
  }
  const primary = counts.reduce<{ server: OpenApiServer; count: number } | null>((best, c) => (!best || c.count > best.count ? c : best), null)?.server ?? null

  // Security: document-wide when every operation has the same.
  const securityJson = ops.length > 0 ? JSON.stringify(ops[0]!.security) : 'null'
  const shared = ops.length > 0 && ops[0]!.security !== null && ops.every((op) => JSON.stringify(op.security) === securityJson)

  const ids = assignOperationIds(ops)
  const paths: OpenApiDocument['paths'] = {}
  ops.forEach((op, i) => {
    // Built key by key for a conventional order in the file (tags, summary, description, operationId, ...).
    const operation = {} as OpenApiOperation
    if (op.tags.length > 0) operation.tags = op.tags
    operation.summary = op.summary
    let description = op.description
    if (op.names.length > 1) {
      const note = `Exported from ${op.names.length} requests: ${op.names.join(', ')}.`
      description = description ? `${description}\n\n${note}` : note
    }
    if (description) operation.description = description
    operation.operationId = ids[i]!
    if (op.deprecated) operation.deprecated = true
    if (op.server && primary && !sameServer(op.server, primary)) operation.servers = [op.server]
    if (op.params.size > 0) operation.parameters = [...op.params.values()]
    if (op.body && op.body.content.size > 0) operation.requestBody = { required: op.body.required, content: finishContent(op.body.content) }
    const responses: Record<string, OpenApiResponse> = {}
    for (const [key, r] of op.responses) {
      const res: OpenApiResponse = { description: r.description }
      if (r.content.size > 0) res.content = finishContent(r.content)
      responses[key] = res
    }
    operation.responses = op.responses.size > 0 ? responses : { default: { description: 'Response' } }
    if (op.security && !shared) operation.security = op.security
    ;(paths[op.path] ??= {})[op.method] = operation
  })

  const info: OpenApiDocument['info'] = { title: collection.name.trim() || 'Collection', version: latestVersion || '1.0.0' }
  if (collection.description?.trim()) info.description = collection.description
  // Built key by key for the conventional order (openapi, info, servers, tags, security, paths, components).
  const document = { openapi: OPENAPI_VERSION, info } as OpenApiDocument
  if (primary) document.servers = [primary]
  const usedTags = tagOrder.filter((t) => ops.some((op) => op.tags.includes(t.name)))
  if (usedTags.length > 0) document.tags = usedTags
  if (shared) document.security = ops[0]!.security!
  document.paths = paths
  // Only schemes an operation still uses (a merged request's own auth may have been dropped).
  const used = new Set(ops.flatMap((op) => (op.security ?? []).flatMap((s) => Object.keys(s))))
  const schemes = [...registry.schemes].filter(([name]) => used.has(name))
  if (schemes.length > 0) document.components = { securitySchemes: Object.fromEntries(schemes) }
  return { document, skippedMcp, skippedMethods }
}

export function exportOpenApi(input: OpenApiExportInput): OpenApiDocument {
  return buildOpenApiExport(input).document
}

export function openApiToYaml(doc: OpenApiDocument): string {
  return dump(doc, { noRefs: true, lineWidth: -1 })
}

export function openApiToJson(doc: OpenApiDocument): string {
  return JSON.stringify(doc, null, 2)
}
