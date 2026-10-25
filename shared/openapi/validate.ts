/**
 * Checking a response against an OpenAPI document (docs/ARCHITECTURE.md, "OpenAPI"): which operation the request is
 * (its `openapi.key`, else method + URL path against the document's paths), which documented response (exact status,
 * `NXX`, `default`) and media type (exact, `+json` for `application/json`, `type/*`, `*\/*`), then the JSON body against
 * the schema with ajv 8.
 *
 * Schemas are converted once per document: OpenAPI 3.0 (and Swagger 2.0, already in that shape) to draft-07 (`nullable`,
 * boolean `exclusiveMinimum`/`exclusiveMaximum`, OpenAPI-only keywords dropped), 3.1 kept as 2020-12. Local `$ref`s are
 * made absolute against the converted document, which ajv holds as one schema, so cycles resolve like any recursive
 * schema. Remote and missing refs accept anything (load.ts already warned about them).
 *
 * Pure and browser-safe: the ajv classes are passed in (main requires them lazily, the browser mock imports them), so
 * this module never loads ajv itself.
 */
import type { default as AjvClass, ErrorObject, Options, ValidateFunction } from 'ajv8'
import type { OpenApiValidation, OpenApiValidationInput } from '../types'
import { isObj, pointer, type Json, type LoadedSpec, type MediaType, type ResolvedResponse, type SpecOperation } from './load'
import { preferredMedia } from './toCollection'

type AjvInstance = InstanceType<typeof AjvClass>
type AjvConstructor = new (opts: Options) => AjvInstance

/** ajv 8's draft-07 class (`ajv8`) and its 2020-12 class (`ajv8/dist/2020`). */
export interface AjvClasses {
  draft7: AjvConstructor
  draft2020: AjvConstructor
}

/** Bodies larger than this are not parsed (the response viewer skips them too). */
export const MAX_VALIDATE_BYTES = 5 * 1024 * 1024
export const MAX_VALIDATION_ERRORS = 50
const VALIDATOR_CACHE = 200
const DOC_CACHE = 8

const result = (status: OpenApiValidation['status'], operation: string | null = null, responseKey: string | null = null, errors: OpenApiValidation['errors'] = []): OpenApiValidation => ({
  status,
  operation,
  responseKey,
  errors,
})

// ---------------------------------------------------------------------------------------------------------------------
// Operation, response and media type

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Server URLs of the document, trailing slashes removed (`{var}` placeholders kept). */
function serverUrls(doc: Json): string[] {
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObj) : []
  return servers.map((s) => (typeof s.url === 'string' ? s.url.trim().replace(/\/+$/, '') : '')).filter(Boolean)
}

/** `https://{region}.x.com/v1` -> a prefix regex where each variable matches one host/path piece. */
const templateRe = (template: string) => new RegExp(`^${escapeRe(template).replace(/\\\{[^}]*\\\}/g, '[^/]*')}`, 'i')

/**
 * The paths a request URL may stand for, most specific first: after `{{baseUrl}}` (any leading `{{variable}}`), after
 * one of the document's server URLs, after scheme+host and a server's path part, after scheme+host alone.
 */
export function pathCandidates(doc: Json, url: string): string[] {
  const u = url.trim().replace(/[?#].*$/, '')
  const out: string[] = []
  const variable = /^\{\{[^{}]+\}\}/.exec(u)
  if (variable) out.push(u.slice(variable[0].length))
  const servers = serverUrls(doc)
  for (const s of servers) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) continue
    const m = templateRe(s).exec(u)
    if (m && (u.length === m[0].length || u[m[0].length] === '/')) out.push(u.slice(m[0].length))
  }
  // `https://host/x` -> `/x`; also `host:8080/x` and `api.example.com/x` (URLs typed without a scheme).
  const hostless = variable ? u.slice(variable[0].length) : u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^[^/{]+[.:][^/]*(?=\/|$)/, '')
  for (const s of servers) {
    const basePath = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    if (!basePath || basePath === '/') continue
    const m = templateRe(basePath).exec(hostless)
    if (m && (hostless.length === m[0].length || hostless[m[0].length] === '/')) out.push(hostless.slice(m[0].length))
  }
  out.push(hostless)
  return [...new Set(out.map((p) => (p.startsWith('/') ? p : `/${p}`)))]
}

const segments = (path: string) => path.split('/').filter((s) => s !== '')

/**
 * How well `path` fits a document path: null when it does not; else one digit per segment, '1' literal, '0' template,
 * so comparing the strings prefers literals from the left (`/pets/mine` beats `/pets/{id}`).
 */
function matchScore(template: string, path: string): string | null {
  const want = segments(template)
  const got = segments(path)
  if (want.length !== got.length) return null
  let score = ''
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!
    const g = got[i]!
    if (w.includes('{')) {
      const re = new RegExp(`^${escapeRe(w).replace(/\\\{[^}]*\\\}/g, '.+')}$`)
      if (!re.test(g) && !re.test(safeDecode(g))) return null
      score += '0'
    } else {
      if (g !== w && safeDecode(g) !== w) return null
      score += '1'
    }
  }
  return score
}

/** The operation a request is: its stored key when the document still has it, else method + URL path. */
export function findOperation(spec: LoadedSpec, method: string, url: string, key: string | null): SpecOperation | null {
  if (key) {
    const byKey = spec.operations.find((o) => o.key === key)
    if (byKey) return byKey
  }
  const m = method.trim().toUpperCase()
  const ops = spec.operations.filter((o) => o.method === m)
  if (!ops.length) return null
  for (const path of pathCandidates(spec.doc, url)) {
    let best: SpecOperation | null = null
    let bestScore = ''
    for (const op of ops) {
      const score = matchScore(op.path, path)
      if (score !== null && (best === null || score > bestScore)) {
        best = op
        bestScore = score
      }
    }
    if (best) return best
  }
  return null
}

/** Exact status, then its class (`4XX`), then `default`. */
export function findResponse(op: SpecOperation, status: number): ResolvedResponse | null {
  const code = String(status)
  return (
    op.responses.find((r) => r.key === code) ??
    op.responses.find((r) => r.key.toUpperCase() === `${code[0]}XX`) ??
    op.responses.find((r) => r.key === 'default') ??
    null
  )
}

const baseType = (t: string | null | undefined) => (t ?? '').split(';')[0]!.trim().toLowerCase()
const JSON_MEDIA = /^application\/(?:[\w.-]*\+)?json$/
const isJsonMedia = (t: string) => JSON_MEDIA.test(t) || /\+json$/.test(t)

/** The documented media type for the response's Content-Type (no Content-Type: the one the import would pick). */
export function findMedia(content: MediaType[], contentType: string | null): MediaType | null {
  const actual = baseType(contentType)
  if (!actual) return preferredMedia(content)
  const by = (want: string) => content.find((m) => baseType(m.type) === want)
  return (
    by(actual) ??
    (isJsonMedia(actual) ? by('application/json') : undefined) ??
    by(`${actual.split('/')[0]}/*`) ??
    by('*/*') ??
    null
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Schema conversion

const SUB_SCHEMA = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'additionalItems', 'contentSchema'])
const SUB_SCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])
const SUB_SCHEMA_MAP = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
/** OpenAPI 3.0 keywords that are not JSON Schema (dropped; with `strict: false` ajv would ignore them anyway). */
const OAS30_ONLY = new Set(['nullable', 'x-nullable', 'example', 'discriminator', 'xml', 'externalDocs', 'deprecated'])

interface Converter {
  doc: Json
  id: string
  oas30: boolean
}

/** `#/components/schemas/Pet` -> absolute against the converted document; null for a ref that cannot resolve. */
function absoluteRef(c: Converter, ref: string): string | null {
  if (!ref.startsWith('#')) return null
  if (pointer(c.doc, ref) === undefined) return null
  const fragment = ref.slice(1).split('/').map((seg) => encodeURIComponent(safeDecode(seg))).join('/')
  return `${c.id}#${fragment}`
}

function propIsWriteOnly(c: Converter, prop: unknown): boolean {
  let p = prop
  for (let i = 0; i < 8 && isObj(p) && typeof p.$ref === 'string'; i++) p = pointer(c.doc, p.$ref)
  return isObj(p) && p.writeOnly === true
}

function convertSchema(c: Converter, s: unknown): unknown {
  if (typeof s === 'boolean') return s
  if (!isObj(s)) return {}
  const out: Json = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === '$ref') {
      const ref = typeof v === 'string' ? absoluteRef(c, v) : null
      if (ref) out.$ref = ref
    } else if (c.oas30 && OAS30_ONLY.has(k)) continue
    else if (SUB_SCHEMA_LIST.has(k) && Array.isArray(v)) out[k] = v.map((x) => convertSchema(c, x))
    else if (SUB_SCHEMA.has(k)) out[k] = convertSchema(c, v)
    else if (SUB_SCHEMA_MAP.has(k) && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([name, x]) => [name, convertSchema(c, x)]))
    else out[k] = v
  }
  // A property that is writeOnly is not in responses, even when required (OpenAPI semantics).
  if (Array.isArray(out.required) && isObj(s.properties)) {
    const props = s.properties
    out.required = out.required.filter((name) => !(typeof name === 'string' && propIsWriteOnly(c, props[name])))
  }
  if (!c.oas30) return out
  for (const [ex, limit] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (typeof out[ex] !== 'boolean') continue
    if (out[ex] === true && typeof out[limit] === 'number') {
      out[ex] = out[limit]
      delete out[limit]
    } else delete out[ex]
  }
  if (s.nullable === true || s['x-nullable'] === true) {
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
    if (typeof out.type === 'string') out.type = [out.type, 'null']
    else if (Array.isArray(out.type)) {
      if (!out.type.includes('null')) out.type = [...out.type, 'null']
    } else if (Object.keys(out).some((k) => k !== 'enum' && k !== 'description' && k !== 'title')) return { anyOf: [out, { type: 'null' }] }
  }
  return out
}

/** The document with every schema converted (schemas sit under `schema` keys and `components.schemas`). */
function convertDoc(c: Converter, v: unknown, parentKey: string | null): unknown {
  if (Array.isArray(v)) return v.map((x) => convertDoc(c, x, null))
  if (!isObj(v)) return v
  const out: Json = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'schema' && (isObj(x) || typeof x === 'boolean')) out[k] = convertSchema(c, x)
    else if (k === 'schemas' && parentKey === 'components' && isObj(x)) out[k] = Object.fromEntries(Object.entries(x).map(([n, s]) => [n, convertSchema(c, s)]))
    else out[k] = convertDoc(c, x, k)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Formats (own checks: no ajv-formats)

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return d <= (m === 2 && !leap ? 28 : DAYS[m - 1]!)
}
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([zZ]|[+-](\d{2}):(\d{2}))?$/
function isDate(s: string): boolean {
  const m = DATE.exec(s)
  return !!m && validDate(Number(m[1]), Number(m[2]), Number(m[3]))
}
function isTime(s: string, needOffset = false): boolean {
  const m = TIME.exec(s)
  if (!m || (needOffset && !m[5])) return false
  return Number(m[1]) < 24 && Number(m[2]) < 60 && Number(m[3]) <= 60 && (m[6] === undefined || (Number(m[6]) < 24 && Number(m[7]) < 60))
}
function isDateTime(s: string): boolean {
  const i = s.search(/[tT ]/)
  return i === 10 && isDate(s.slice(0, i)) && isTime(s.slice(i + 1), true)
}
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
function isIpv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return false
  try {
    // The WHATWG URL parser accepts exactly the IPv6 address forms (incl. `::` and an embedded IPv4 part).
    return new URL(`http://[${s}]/`).hostname.length > 2
  } catch {
    return false
  }
}
const INT32 = 2 ** 31

function addFormats(ajv: AjvInstance) {
  const str = (name: string, test: (s: string) => boolean) => ajv.addFormat(name, { type: 'string', validate: test })
  const num = (name: string, test: (n: number) => boolean) => ajv.addFormat(name, { type: 'number', validate: test })
  str('date-time', isDateTime)
  str('date', isDate)
  str('time', (s) => isTime(s))
  str('email', (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
  str('uuid', (s) => /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
  str('uri', (s) => /^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(s))
  str('ipv4', (s) => IPV4.test(s))
  str('ipv6', isIpv6)
  str('byte', (s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s))
  // Formats that only describe the value (any string / number of the right type passes).
  for (const name of ['binary', 'password']) ajv.addFormat(name, true)
  num('int32', (n) => Number.isInteger(n) && n >= -INT32 && n < INT32)
  num('int64', (n) => Number.isInteger(n))
  num('float', (n) => Number.isFinite(n))
  num('double', (n) => Number.isFinite(n))
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors

/** `/items/0/price` -> `$.items[0].price` */
export function jsonPath(instancePath: string): string {
  if (!instancePath) return '$'
  let out = '$'
  for (const raw of instancePath.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (/^\d+$/.test(seg)) out += `[${seg}]`
    else if (/^[A-Za-z_$][\w$]*$/.test(seg)) out += `.${seg}`
    else out += `[${JSON.stringify(seg)}]`
  }
  return out
}

function kind(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

const short = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

function message(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>
  switch (e.keyword) {
    case 'type':
      return `expected ${String(p.type).split(',').join(' or ')}, got ${kind(e.data)}`
    case 'required':
      return `missing required property '${String(p.missingProperty)}'`
    case 'additionalProperties':
      return `unexpected property '${String(p.additionalProperty)}'`
    case 'enum':
      return `expected one of ${(Array.isArray(p.allowedValues) ? p.allowedValues : []).map(short).join(', ')}, got ${short(e.data)}`
    case 'const':
      return `expected ${short(p.allowedValue)}, got ${short(e.data)}`
    case 'format':
      return `expected a ${String(p.format)} value, got ${short(e.data)}`
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return `expected a number ${String(p.comparison)} ${String(p.limit)}, got ${short(e.data)}`
    case 'minLength':
      return `expected at least ${plural(Number(p.limit), 'character')}`
    case 'maxLength':
      return `expected at most ${plural(Number(p.limit), 'character')}`
    case 'minItems':
      return `expected at least ${plural(Number(p.limit), 'item')}, got ${Array.isArray(e.data) ? e.data.length : 0}`
    case 'maxItems':
      return `expected at most ${plural(Number(p.limit), 'item')}, got ${Array.isArray(e.data) ? e.data.length : 0}`
    case 'minProperties':
      return `expected at least ${plural(Number(p.limit), 'property', 'properties')}`
    case 'maxProperties':
      return `expected at most ${plural(Number(p.limit), 'property', 'properties')}`
    case 'pattern':
      return `expected to match the pattern ${String(p.pattern)}, got ${short(e.data)}`
    case 'multipleOf':
      return `expected a multiple of ${String(p.multipleOf)}, got ${short(e.data)}`
    case 'uniqueItems':
      return `expected unique items (items ${String(p.j)} and ${String(p.i)} are equal)`
    case 'anyOf':
      return 'does not match any of the allowed schemas'
    case 'oneOf':
      return Array.isArray(p.passingSchemas) ? 'matches more than one of the allowed schemas (oneOf)' : 'does not match any of the allowed schemas (oneOf)'
    case 'not':
      return 'matches a schema it must not match'
    case 'false schema':
      return 'no value is allowed here'
    default:
      return e.message ?? `fails "${e.keyword}"`
  }
}

/**
 * ajv errors -> path + message. The branch errors of a failed anyOf/oneOf are left out (one "does not match any" says it),
 * duplicates too, and so are other errors of a value with the wrong type; at most 50.
 */
export function toErrors(errors: ErrorObject[] | null | undefined): OpenApiValidation['errors'] {
  const list = errors ?? []
  const groups = list.filter((e) => e.keyword === 'anyOf' || (e.keyword === 'oneOf' && !(e.params as { passingSchemas?: unknown }).passingSchemas)).map((e) => `${e.schemaPath}/`)
  // A value of the wrong type: its other errors (format, minimum...) say nothing more.
  const wrongType = new Set(list.filter((e) => e.keyword === 'type').map((e) => e.instancePath))
  const out: OpenApiValidation['errors'] = []
  const seen = new Set<string>()
  for (const e of list) {
    if (groups.some((g) => e.schemaPath.startsWith(g))) continue
    if (e.keyword !== 'type' && wrongType.has(e.instancePath)) continue
    const item = { path: jsonPath(e.instancePath), message: message(e) }
    const key = `${item.path}\n${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= MAX_VALIDATION_ERRORS) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation

/** A small LRU on Map insertion order. */
class Lru<V> {
  readonly #map = new Map<string, V>()
  constructor(readonly limit: number) {}
  get(key: string): V | undefined {
    const v = this.#map.get(key)
    if (v !== undefined) {
      this.#map.delete(key)
      this.#map.set(key, v)
    }
    return v
  }
  set(key: string, v: V) {
    this.#map.delete(key)
    this.#map.set(key, v)
    if (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value!)
  }
  get size() {
    return this.#map.size
  }
  clear() {
    this.#map.clear()
  }
}

function decodeBody(input: OpenApiValidationInput): { text: string; bytes: number } {
  if (input.bodyEncoding !== 'base64') return { text: input.body, bytes: input.body.length }
  const bytes = Math.floor((input.body.length * 3) / 4)
  if (bytes > MAX_VALIDATE_BYTES) return { text: '', bytes }
  try {
    const bin = atob(input.body)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return { text: new TextDecoder().decode(arr), bytes }
  } catch {
    return { text: '', bytes }
  }
}

/** `type: string` (directly or through refs): any body is valid text for it. */
function isStringSchema(doc: Json, schema: Json): boolean {
  let s: unknown = schema
  for (let i = 0; i < 8 && isObj(s) && typeof s.$ref === 'string'; i++) s = pointer(doc, s.$ref)
  return isObj(s) && (s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string')))
}

export interface ResponseValidator {
  validate(spec: LoadedSpec, specHash: string, input: OpenApiValidationInput, requestOperationKey: string | null): OpenApiValidation
  /** How many schemas were compiled (tests: the cache works). */
  stats(): { compiled: number; cached: number }
  clear(): void
}

type Compiled = { fn: ValidateFunction } | { error: string }

export function createResponseValidator(classes: AjvClasses): ResponseValidator {
  const validators = new Lru<Compiled>(VALIDATOR_CACHE)
  const docs = new Lru<AjvInstance>(DOC_CACHE)
  let compiled = 0

  /** One ajv per document, holding the converted document as the schema `<id>`. */
  function ajvFor(spec: LoadedSpec, specHash: string): { ajv: AjvInstance; id: string; c: Converter } {
    const id = `https://openapi.slinger.local/${encodeURIComponent(specHash)}`
    const c: Converter = { doc: spec.doc, id, oas30: spec.version !== '3.1' }
    let ajv = docs.get(specHash)
    if (!ajv) {
      const Ctor = spec.version === '3.1' ? classes.draft2020 : classes.draft7
      ajv = new Ctor({ allErrors: true, strict: false, verbose: true, validateSchema: false, logger: false, unicodeRegExp: false })
      addFormats(ajv)
      const converted = convertDoc(c, spec.doc, null) as Json
      delete converted.$id
      delete converted.$schema
      ajv.addSchema({ ...converted, $id: id })
      docs.set(specHash, ajv)
    }
    return { ajv, id, c }
  }

  function compile(spec: LoadedSpec, specHash: string, op: SpecOperation, resp: ResolvedResponse, media: MediaType): Compiled {
    const key = `${specHash}\u0000${op.key}\u0000${resp.key}\u0000${media.type}`
    const hit = validators.get(key)
    if (hit) return hit
    let out: Compiled
    try {
      const { ajv, c } = ajvFor(spec, specHash)
      compiled++
      out = { fn: ajv.compile(convertSchema(c, media.schema) as Json) }
    } catch (e) {
      out = { error: e instanceof Error ? e.message : String(e) }
    }
    validators.set(key, out)
    return out
  }

  return {
    validate(spec, specHash, input, requestOperationKey) {
      const op = findOperation(spec, input.method, input.url, requestOperationKey)
      if (!op) return result('no-operation')
      const resp = findResponse(op, input.status)
      if (!resp) {
        const documented = op.responses.map((r) => r.key)
        const which = documented.length ? `documented: ${documented.join(', ')}` : 'no responses are documented'
        return result('invalid', op.key, null, [{ path: '$', message: `Status ${input.status} is not documented for ${op.key} (${which})` }])
      }
      if (!resp.content.length) return result('no-schema', op.key, resp.key)
      const media = findMedia(resp.content, input.contentType)
      if (!media) {
        const documented = resp.content.map((m) => m.type).join(', ')
        return result('invalid', op.key, resp.key, [
          { path: '$', message: `Content type ${baseType(input.contentType)} is not documented for ${op.key} ${resp.key} (documented: ${documented})` },
        ])
      }
      if (!media.schema) return result('no-schema', op.key, resp.key)
      const body = decodeBody(input)
      if (body.bytes > MAX_VALIDATE_BYTES) return result('not-json', op.key, resp.key, [{ path: '$', message: 'Too large to check (over 5 MB)' }])
      const mediaType = baseType(media.type)
      const jsonish = isJsonMedia(mediaType) || (mediaType.endsWith('*') && isJsonMedia(baseType(input.contentType)))
      // Text and binary bodies are fine for a string schema; anything else needs JSON.
      if (!jsonish && isStringSchema(spec.doc, media.schema)) return result('valid', op.key, resp.key)
      let data: unknown
      try {
        data = JSON.parse(body.text)
      } catch (e) {
        const why = body.text.trim() === '' ? 'the body is empty' : `the body is not valid JSON (${(e as Error).message})`
        return result('not-json', op.key, resp.key, [{ path: '$', message: `Expected a JSON body: ${why}` }])
      }
      const v = compile(spec, specHash, op, resp, media)
      if ('error' in v) return result('no-schema', op.key, resp.key, [{ path: '$', message: `The schema could not be used: ${v.error}` }])
      if (v.fn(data)) return result('valid', op.key, resp.key)
      return result('invalid', op.key, resp.key, toErrors(v.fn.errors))
    },
    stats: () => ({ compiled, cached: validators.size }),
    clear() {
      validators.clear()
      docs.clear()
      compiled = 0
    },
  }
}
