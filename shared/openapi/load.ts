/**
 * Reading an OpenAPI (3.0, 3.1) or Swagger (2.0) document: JSON or YAML text -> one OpenAPI 3 shaped document plus the
 * list of its operations with parameters, bodies and responses resolved (see docs/ARCHITECTURE.md, "OpenAPI").
 *
 * Swagger 2.0 is converted on the way in (servers from host/basePath/schemes, `in: body` and `in: formData` parameters to
 * request bodies, `produces` + response `schema` to content, `definitions` to `components.schemas`), so everything after
 * this module handles one shape. The document is never executed: YAML is read with the JSON schema (no custom tags).
 * Remote `$ref`s (other files, URLs) are not followed: they are reported in `warnings` and read as `{}`.
 */
import yaml from 'js-yaml'

/** A document that cannot be read (main turns it into an `invalid_input` IpcError, the browser mock likewise). */
export class OpenApiError extends Error {
  override name = 'OpenApiError'
}
const invalidInput = (message: string) => new OpenApiError(message)

export type Json = Record<string, unknown>
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

export interface ResolvedParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  description: string | null
  deprecated: boolean
  schema: Json
  /** An explicit example (parameter `example`, first of `examples`, else the schema's own); undefined when none. */
  example: unknown
  style: string | null
  explode: boolean | null
}

export interface MediaType {
  /** e.g. `application/json` (as written in the document). */
  type: string
  schema: Json | null
  /** Named examples (`examples`), else the single `example` as `{ default: ... }`; empty when none. */
  examples: Array<{ name: string; summary: string | null; value: unknown }>
  /** Per-property `encoding` (multipart content types). */
  encoding: Json | null
}

export interface ResolvedRequestBody {
  required: boolean
  description: string | null
  content: MediaType[]
}

export interface ResolvedResponse {
  /** As in the document: "200", "2XX", "default". */
  key: string
  description: string
  headers: Array<{ name: string; schema: Json; example: unknown; description: string | null }>
  content: MediaType[]
}

export interface SecurityRequirement {
  [scheme: string]: string[]
}

export interface SpecOperation {
  /** "GET /pets/{petId}": the method in upper case and the path exactly as in `paths`. */
  key: string
  method: string
  path: string
  operationId: string | null
  summary: string | null
  description: string | null
  tags: string[]
  deprecated: boolean
  parameters: ResolvedParameter[]
  requestBody: ResolvedRequestBody | null
  responses: ResolvedResponse[]
  /** The operation's own `security` (null: the document's applies). */
  security: SecurityRequirement[] | null
}

export interface LoadedSpec {
  version: '2.0' | '3.0' | '3.1'
  /** OpenAPI 3 shaped document; `$ref`s are kept (cycles are possible). */
  doc: Json
  title: string
  specVersion: string
  operations: SpecOperation[]
  warnings: string[]
}

/** JSON or YAML text -> value. Throws invalid_input with a readable reason. */
export function parseSpecText(text: string): unknown {
  const t = text.replace(/^﻿/, '').trim()
  if (!t) throw invalidInput('The document is empty')
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t)
    } catch (e) {
      throw invalidInput(`Not valid JSON: ${(e as Error).message}`)
    }
  }
  try {
    return yaml.load(t, { schema: yaml.JSON_SCHEMA, json: true })
  } catch (e) {
    const err = e as { reason?: string; mark?: { line: number; column: number }; message: string }
    const where = err.mark ? ` (line ${err.mark.line + 1}, column ${err.mark.column + 1})` : ''
    throw invalidInput(`Not valid YAML: ${err.reason ?? err.message}${where}`)
  }
}

/** Does this value look like an OpenAPI or Swagger document? (cheap, for detecting pasted text) */
export function isOpenApiValue(value: unknown): boolean {
  return isObj(value) && ((typeof value.openapi === 'string' && /^3\./.test(value.openapi)) || value.swagger === '2.0' || value.swagger === 2) && (isObj(value.paths) || isObj(value.webhooks))
}

// ---------------------------------------------------------------------------------------------------------------------
// $ref resolution

/** The value at a local JSON pointer (`#/components/schemas/Pet`); undefined when it does not exist. */
export function pointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined
  const parts = ref.slice(1).split('/').filter((p, i) => !(i === 0 && p === ''))
  let cur: unknown = doc
  for (const raw of parts) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) cur = cur[Number(key)]
    else if (isObj(cur)) cur = cur[key]
    else return undefined
  }
  return cur
}

/**
 * Follows `$ref` chains of an object (not into its properties). Remote or missing refs give `{}` and a warning; a chain
 * that loops gives `{}`.
 */
export function deref(doc: Json, value: unknown, warnings?: string[]): Json {
  let cur = value
  const seen = new Set<string>()
  while (isObj(cur) && typeof cur.$ref === 'string') {
    const ref = cur.$ref
    if (seen.has(ref)) return {}
    seen.add(ref)
    if (!ref.startsWith('#')) {
      warnings?.push(`Not followed: the reference "${ref}" points outside this document.`)
      return {}
    }
    const next = pointer(doc, ref)
    if (next === undefined) {
      warnings?.push(`Not found: the reference "${ref}".`)
      return {}
    }
    // OpenAPI 3.1 allows siblings next to $ref (summary/description): they win over the target's.
    const { $ref: _ref, ...siblings } = cur
    cur = Object.keys(siblings).length && isObj(next) ? { ...next, ...siblings } : next
  }
  return isObj(cur) ? cur : {}
}

// ---------------------------------------------------------------------------------------------------------------------
// Swagger 2.0 -> OpenAPI 3

/** Rewrites `#/definitions/X` (and parameters/responses) refs to their OpenAPI 3 places, deeply. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs)
  if (!isObj(value)) return value
  const out: Json = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === '$ref' && typeof v === 'string') {
      out[k] = v
        .replace(/^#\/definitions\//, '#/components/schemas/')
        .replace(/^#\/parameters\//, '#/components/parameters/')
        .replace(/^#\/responses\//, '#/components/responses/')
    } else out[k] = rewriteRefs(v)
  }
  return out
}

const SWAGGER_SCHEMA_KEYS = ['type', 'format', 'items', 'collectionFormat', 'default', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'enum', 'multipleOf']

/** A Swagger non-body parameter's schema keywords moved into `schema`. */
function swaggerParamSchema(p: Json): Json {
  const schema: Json = {}
  for (const k of SWAGGER_SCHEMA_KEYS) if (p[k] !== undefined && k !== 'collectionFormat') schema[k] = p[k]
  if (schema.type === 'file') {
    schema.type = 'string'
    schema.format = 'binary'
  }
  return schema
}

function swagger2ToOpenApi3(src: Json, warnings: string[]): Json {
  const s = rewriteRefs(src) as Json
  const schemes = Array.isArray(s.schemes) && s.schemes.length ? (s.schemes as unknown[]).map(String) : ['https']
  const host = str(s.host)
  const basePath = str(s.basePath) ?? ''
  const servers = host ? schemes.map((scheme) => ({ url: `${scheme}://${host}${basePath === '/' ? '' : basePath}` })) : basePath ? [{ url: basePath }] : []
  const globalConsumes = Array.isArray(s.consumes) ? (s.consumes as unknown[]).map(String) : ['application/json']
  const globalProduces = Array.isArray(s.produces) ? (s.produces as unknown[]).map(String) : ['application/json']
  const components: Json = {}
  if (isObj(s.definitions)) components.schemas = s.definitions
  if (isObj(s.securityDefinitions)) {
    const schemes3: Json = {}
    for (const [name, raw] of Object.entries(s.securityDefinitions)) {
      if (!isObj(raw)) continue
      if (raw.type === 'basic') schemes3[name] = { type: 'http', scheme: 'basic', description: raw.description }
      else if (raw.type === 'apiKey') schemes3[name] = { type: 'apiKey', name: raw.name, in: raw.in, description: raw.description }
      else if (raw.type === 'oauth2') {
        const flowName = ({ implicit: 'implicit', password: 'password', application: 'clientCredentials', accessCode: 'authorizationCode' } as Record<string, string>)[String(raw.flow)] ?? 'clientCredentials'
        schemes3[name] = {
          type: 'oauth2',
          description: raw.description,
          flows: { [flowName]: { authorizationUrl: raw.authorizationUrl, tokenUrl: raw.tokenUrl, scopes: isObj(raw.scopes) ? raw.scopes : {} } },
        }
      }
    }
    components.securitySchemes = schemes3
  }
  const sharedParams = isObj(s.parameters) ? s.parameters : {}
  const sharedResponses = isObj(s.responses) ? s.responses : {}
  const resolveParam = (p: unknown): Json => {
    if (isObj(p) && typeof p.$ref === 'string') {
      const name = p.$ref.replace('#/components/parameters/', '')
      return isObj(sharedParams[name]) ? (sharedParams[name] as Json) : {}
    }
    return isObj(p) ? p : {}
  }
  const convertResponse = (r: unknown, produces: string[]): Json => {
    let resp = r
    if (isObj(resp) && typeof resp.$ref === 'string') {
      const name = resp.$ref.replace('#/components/responses/', '')
      resp = sharedResponses[name]
    }
    if (!isObj(resp)) return { description: '' }
    const out: Json = { description: typeof resp.description === 'string' ? resp.description : '' }
    if (isObj(resp.headers)) {
      out.headers = Object.fromEntries(
        Object.entries(resp.headers).map(([h, def]) => [h, isObj(def) ? { description: def.description, schema: swaggerParamSchema(def) } : {}]),
      )
    }
    const examples = isObj(resp.examples) ? resp.examples : {}
    if (resp.schema !== undefined || Object.keys(examples).length) {
      const content: Json = {}
      for (const type of produces) content[type] = { schema: resp.schema, ...(examples[type] !== undefined ? { example: examples[type] } : {}) }
      out.content = content
    }
    return out
  }
  const paths: Json = {}
  for (const [path, rawItem] of Object.entries(isObj(s.paths) ? s.paths : {})) {
    if (!isObj(rawItem)) continue
    const item: Json = {}
    const pathParams = Array.isArray(rawItem.parameters) ? rawItem.parameters.map(resolveParam) : []
    for (const m of HTTP_METHODS) {
      const op = rawItem[m]
      if (!isObj(op)) continue
      const consumes = Array.isArray(op.consumes) ? (op.consumes as unknown[]).map(String) : globalConsumes
      const produces = Array.isArray(op.produces) ? (op.produces as unknown[]).map(String) : globalProduces
      const params = [...pathParams.filter((pp) => !(Array.isArray(op.parameters) && op.parameters.map(resolveParam).some((o) => o.name === pp.name && o.in === pp.in))), ...(Array.isArray(op.parameters) ? op.parameters.map(resolveParam) : [])]
      const parameters: Json[] = []
      let requestBody: Json | null = null
      const formProps: Json = {}
      const formRequired: string[] = []
      for (const p of params) {
        if (p.in === 'body') {
          requestBody = {
            required: p.required === true,
            description: p.description,
            content: Object.fromEntries(consumes.map((type) => [type, { schema: p.schema ?? {}, ...(p['x-example'] !== undefined ? { example: p['x-example'] } : {}) }])),
          }
        } else if (p.in === 'formData') {
          formProps[String(p.name)] = { ...swaggerParamSchema(p), ...(p.description ? { description: p.description } : {}) }
          if (p.required === true) formRequired.push(String(p.name))
        } else if (p.in === 'path' || p.in === 'query' || p.in === 'header') {
          const multi = p.collectionFormat === 'multi'
          parameters.push({
            name: p.name,
            in: p.in,
            required: p.in === 'path' ? true : p.required === true,
            description: p.description,
            schema: swaggerParamSchema(p),
            ...(multi ? { explode: true } : p.type === 'array' ? { explode: false } : {}),
            ...(p['x-example'] !== undefined ? { example: p['x-example'] } : {}),
          })
        }
      }
      if (!requestBody && Object.keys(formProps).length) {
        const hasFile = Object.values(formProps).some((v) => isObj(v) && v.format === 'binary')
        const formTypes = consumes.filter((c) => /form/.test(c))
        const type = hasFile ? 'multipart/form-data' : (formTypes[0] ?? 'application/x-www-form-urlencoded')
        requestBody = { content: { [type]: { schema: { type: 'object', properties: formProps, ...(formRequired.length ? { required: formRequired } : {}) } } } }
      }
      const responses: Json = {}
      for (const [code, r] of Object.entries(isObj(op.responses) ? op.responses : {})) responses[code] = convertResponse(r, produces)
      item[m] = {
        ...(Array.isArray(op.tags) ? { tags: op.tags } : {}),
        ...(op.summary !== undefined ? { summary: op.summary } : {}),
        ...(op.description !== undefined ? { description: op.description } : {}),
        ...(op.operationId !== undefined ? { operationId: op.operationId } : {}),
        ...(op.deprecated === true ? { deprecated: true } : {}),
        ...(op.security !== undefined ? { security: op.security } : {}),
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses,
      }
    }
    paths[path] = item
  }
  if (!host) warnings.push('The Swagger document has no host: requests use a relative base URL.')
  return {
    openapi: '3.0.3',
    info: isObj(s.info) ? s.info : { title: 'API', version: '1.0.0' },
    servers,
    paths,
    components,
    ...(Array.isArray(s.security) ? { security: s.security } : {}),
    ...(Array.isArray(s.tags) ? { tags: s.tags } : {}),
    ...(isObj(s.externalDocs) ? { externalDocs: s.externalDocs } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Operations

function mediaTypes(doc: Json, content: unknown, warnings: string[]): MediaType[] {
  if (!isObj(content)) return []
  return Object.entries(content).map(([type, raw]) => {
    const m = deref(doc, raw, warnings)
    const examples: MediaType['examples'] = []
    if (isObj(m.examples)) {
      for (const [name, ex] of Object.entries(m.examples)) {
        const e = deref(doc, ex, warnings)
        if ('value' in e) examples.push({ name, summary: str(e.summary), value: e.value })
        else if (typeof e.externalValue === 'string') warnings.push(`Not loaded: the example "${name}" is an external file (${e.externalValue}).`)
      }
    }
    if (!examples.length && m.example !== undefined) examples.push({ name: 'default', summary: null, value: m.example })
    return { type, schema: isObj(m.schema) ? m.schema : null, examples, encoding: isObj(m.encoding) ? m.encoding : null }
  })
}

function resolveParameter(doc: Json, raw: unknown, warnings: string[]): ResolvedParameter | null {
  const p = deref(doc, raw, warnings)
  const name = str(p.name)
  const where = p.in
  if (!name || (where !== 'path' && where !== 'query' && where !== 'header' && where !== 'cookie')) return null
  let schema = isObj(p.schema) ? p.schema : {}
  // `content` instead of `schema` (OpenAPI 3): the first media type's schema.
  if (!isObj(p.schema) && isObj(p.content)) {
    const first = Object.values(p.content)[0]
    if (isObj(first) && isObj(first.schema)) schema = first.schema
  }
  let example: unknown = p.example
  if (example === undefined && isObj(p.examples)) {
    const first = Object.values(p.examples)[0]
    const e = deref(doc, first, warnings)
    if ('value' in e) example = e.value
  }
  return {
    name,
    in: where,
    required: where === 'path' ? true : p.required === true,
    description: str(p.description),
    deprecated: p.deprecated === true,
    schema,
    example,
    style: str(p.style),
    explode: typeof p.explode === 'boolean' ? p.explode : null,
  }
}

function collectOperations(doc: Json, warnings: string[]): SpecOperation[] {
  const out: SpecOperation[] = []
  for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const item = deref(doc, rawItem, warnings)
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const m of HTTP_METHODS) {
      const op = item[m]
      if (!isObj(op)) continue
      const own = (Array.isArray(op.parameters) ? op.parameters : []).map((p) => resolveParameter(doc, p, warnings)).filter((p): p is ResolvedParameter => !!p)
      const inherited = shared
        .map((p) => resolveParameter(doc, p, warnings))
        .filter((p): p is ResolvedParameter => !!p && !own.some((o) => o.name === p.name && o.in === p.in))
      let requestBody: ResolvedRequestBody | null = null
      if (op.requestBody !== undefined) {
        const rb = deref(doc, op.requestBody, warnings)
        requestBody = { required: rb.required === true, description: str(rb.description), content: mediaTypes(doc, rb.content, warnings) }
      }
      const responses: ResolvedResponse[] = Object.entries(isObj(op.responses) ? op.responses : {}).map(([key, raw]) => {
        const r = deref(doc, raw, warnings)
        const headers = Object.entries(isObj(r.headers) ? r.headers : {}).map(([name, h]) => {
          const hd = deref(doc, h, warnings)
          return { name, schema: isObj(hd.schema) ? hd.schema : {}, example: hd.example, description: str(hd.description) }
        })
        return { key, description: typeof r.description === 'string' ? r.description : '', headers, content: mediaTypes(doc, r.content, warnings) }
      })
      out.push({
        key: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        path,
        operationId: str(op.operationId),
        summary: str(op.summary),
        description: str(op.description),
        tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [],
        deprecated: op.deprecated === true,
        parameters: [...inherited, ...own],
        requestBody,
        responses,
        security: Array.isArray(op.security) ? (op.security.filter(isObj) as SecurityRequirement[]) : null,
      })
    }
  }
  return out
}

/** Every `$ref` that points outside the document (other files, URLs), once each. */
function remoteRefs(doc: Json): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (depth > 200) return
    if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (isObj(v)) {
      if (typeof v.$ref === 'string' && !v.$ref.startsWith('#')) out.add(v.$ref)
      for (const x of Object.values(v)) walk(x, depth + 1)
    }
  }
  walk(doc, 0)
  return [...out]
}

/** Parses and normalizes a document (see the module comment). */
export function loadSpec(text: string): LoadedSpec {
  return loadSpecValue(parseSpecText(text))
}

export function loadSpecValue(value: unknown): LoadedSpec {
  if (!isObj(value)) throw invalidInput('Not an OpenAPI or Swagger document: the top level is not an object')
  const warnings: string[] = []
  let version: LoadedSpec['version']
  let doc: Json
  if (value.swagger === '2.0' || value.swagger === 2) {
    version = '2.0'
    doc = swagger2ToOpenApi3(value, warnings)
  } else if (typeof value.openapi === 'string' && /^3\.0(\.|$)/.test(value.openapi)) {
    version = '3.0'
    doc = value
  } else if (typeof value.openapi === 'string' && /^3\.1(\.|$)/.test(value.openapi)) {
    version = '3.1'
    doc = value
  } else if (typeof value.openapi === 'string') {
    throw invalidInput(`OpenAPI ${value.openapi} is not supported (3.0, 3.1 and Swagger 2.0 are)`)
  } else {
    throw invalidInput('Not an OpenAPI or Swagger document: it has no "openapi" or "swagger" field')
  }
  if (!isObj(doc.paths) || Object.keys(doc.paths).length === 0) {
    if (isObj(doc.webhooks)) throw invalidInput('This document only describes webhooks: there are no paths to import')
    throw invalidInput('The document has no paths')
  }
  const info = isObj(doc.info) ? doc.info : {}
  for (const ref of remoteRefs(doc)) warnings.push(`Not followed: the reference "${ref}" points outside this document.`)
  const operations = collectOperations(doc, warnings)
  if (operations.length === 0) throw invalidInput('The document has no operations')
  if (isObj(doc.webhooks)) warnings.push('Webhooks are not imported.')
  return {
    version,
    doc,
    title: (str(info.title) ?? 'API').slice(0, 200),
    specVersion: str(info.version) ?? '',
    operations,
    warnings: [...new Set(warnings)].slice(0, 50),
  }
}
