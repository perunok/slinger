/**
 * Form model for a JSON Schema (an MCP tool's `inputSchema`) edited against JSON text (`McpDraft.arguments`).
 *
 * The JSON text stays the source of truth: the form parses it, changes one value at a path and writes it back, so
 * keys the schema does not know and the existing key order survive (new keys go in schema order). The text may hold
 * `{{variables}}`: inside strings as usual, and as a bare token standing for a whole value (`{"n": {{n}}}`), which is
 * how number and boolean fields store a variable so that it resolves to a number or boolean before `JSON.parse`
 * (`prepareMcp`). Such a token is a `BareToken` in the parsed value.
 *
 * Supported: string (enum -> select, `format` hints), number / integer, boolean, arrays of those (rows), nested objects
 * (fieldsets), local `$ref`s, `allOf` (merged), `anyOf`/`oneOf`/type lists that are just "X or null" (as X). Anything
 * else (real unions, maps, arrays of objects, tuples) is a `json` field edited as a JSON sub-document.
 */
import { substituteTokens } from './jsonTemplate'
import { parseTokens } from './template'

export type JsonSchema = Record<string, unknown>
export type FieldKind = 'string' | 'enum' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'

export interface SchemaField {
  key: string
  /** Keys from the arguments root to this field. */
  path: string[]
  kind: FieldKind
  title: string | null
  description: string | null
  required: boolean
  hasDefault: boolean
  default: unknown
  /** enum: the allowed values (primitives). */
  enumValues: unknown[]
  /** string: `format` (date-time, email, uri, ...). */
  format: string | null
  /** Human-readable limits (minimum, length, pattern, item count). */
  constraints: string[]
  /** array: the item field (always a primitive kind; its key is ''). */
  item: SchemaField | null
  /** object: the property fields, in schema order. */
  fields: SchemaField[]
}

/** A whole-value `{{variable}}` written without quotes in the JSON text. */
export class BareToken {
  constructor(readonly raw: string) {}
}

export type JsonParse<T> = { ok: true; value: T } | { ok: false; error: string }

type Json = Record<string, unknown>
const isPlainObject = (v: unknown): v is Json => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const hasOwn = (o: Json, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const isPrimitive = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const PRIMITIVE_KINDS: readonly FieldKind[] = ['string', 'enum', 'number', 'integer', 'boolean']
/** Schema nesting (refs included) beyond this is treated as recursive. */
const MAX_DEPTH = 12
/** Objects nested deeper than this are a `json` field. */
const MAX_OBJECT_NESTING = 4

// ---------------------------------------------------------------------------
// Schema -> fields
// ---------------------------------------------------------------------------

/** Follows a local `#/...` JSON pointer; anything else (remote refs) is unresolvable. */
function lookupRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return null
  let cur: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    let part: string
    try {
      part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    } catch {
      return null
    }
    if (!isPlainObject(cur) || !hasOwn(cur, part)) return null
    cur = cur[part]
  }
  return isPlainObject(cur) ? cur : null
}

/** Shallow merge of several schemas: properties merged, required joined, other keys first one wins. */
function mergeSchemas(parts: JsonSchema[]): JsonSchema {
  const out: JsonSchema = {}
  const properties: Json = {}
  const required: string[] = []
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if (k === 'properties' && isPlainObject(v)) Object.assign(properties, v)
      else if (k === 'required' && Array.isArray(v)) required.push(...v.filter((x): x is string => typeof x === 'string'))
      else if (!hasOwn(out, k)) out[k] = v
    }
  }
  if (Object.keys(properties).length) out.properties = properties
  if (required.length) out.required = [...new Set(required)]
  return out
}

const isNullSchema = (s: unknown) => isPlainObject(s) && (s.type === 'null' || (Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === null))

/**
 * Resolves refs, merges `allOf` and unwraps "X or null" unions into X. Returns null when the schema is (or refers to)
 * something deeper than MAX_DEPTH, i.e. recursive.
 */
function normalize(schema: unknown, root: JsonSchema, depth: number): JsonSchema | null {
  if (depth > MAX_DEPTH) return null
  if (schema === true || schema === undefined) return {}
  if (!isPlainObject(schema)) return {}
  let s: JsonSchema = schema
  if (typeof s.$ref === 'string') {
    const target = lookupRef(s.$ref, root)
    const resolved = target ? normalize(target, root, depth + 1) : {}
    if (!resolved) return null
    const { $ref: _ref, ...rest } = s
    s = mergeSchemas([rest, resolved])
  }
  if (Array.isArray(s.allOf)) {
    const parts: JsonSchema[] = []
    for (const p of s.allOf) {
      const n = normalize(p, root, depth + 1)
      if (!n) return null
      parts.push(n)
    }
    const { allOf: _allOf, ...rest } = s
    s = mergeSchemas([rest, ...parts])
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const list = s[key]
    if (!Array.isArray(list)) continue
    const nonNull = list.filter((x) => !isNullSchema(x))
    if (nonNull.length !== 1) continue
    const inner = normalize(nonNull[0], root, depth + 1)
    if (!inner) return null
    const { [key]: _union, ...rest } = s
    s = mergeSchemas([rest, inner])
  }
  if (Array.isArray(s.type)) {
    const types = s.type.filter((t) => t !== 'null')
    if (types.length === 1) s = { ...s, type: types[0] }
  }
  if (hasOwn(s, 'const') && !Array.isArray(s.enum)) s = { ...s, enum: [s.const] }
  return s
}

function constraintsOf(s: JsonSchema): string[] {
  const out: string[] = []
  const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null)
  const min = num('minimum')
  const max = num('maximum')
  const xmin = num('exclusiveMinimum')
  const xmax = num('exclusiveMaximum')
  if (min !== null) out.push(`Minimum ${min}`)
  if (xmin !== null) out.push(`Greater than ${xmin}`)
  if (max !== null) out.push(`Maximum ${max}`)
  if (xmax !== null) out.push(`Less than ${xmax}`)
  if (num('multipleOf') !== null) out.push(`Multiple of ${num('multipleOf')}`)
  const range = (lo: number | null, hi: number | null, noun: string) => {
    if (lo !== null && hi !== null) out.push(lo === hi ? `Exactly ${lo} ${noun}` : `${lo} to ${hi} ${noun}`)
    else if (lo !== null) out.push(`At least ${lo} ${noun}`)
    else if (hi !== null) out.push(`At most ${hi} ${noun}`)
  }
  range(num('minLength'), num('maxLength'), 'characters')
  range(num('minItems'), num('maxItems'), 'items')
  if (typeof s.pattern === 'string') out.push(`Pattern ${s.pattern}`)
  if (s.uniqueItems === true) out.push('Items must be unique')
  return out
}

function kindOf(s: JsonSchema, root: JsonSchema, depth: number): { kind: FieldKind; item: SchemaField | null } {
  const none = { item: null }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf) || Array.isArray(s.type) || s.not !== undefined) return { kind: 'json', ...none }
  if (Array.isArray(s.enum) && s.enum.length > 0) return { kind: s.enum.every(isPrimitive) ? 'enum' : 'json', ...none }
  const type = typeof s.type === 'string' ? s.type : s.properties ? 'object' : s.items ? 'array' : null
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return { kind: type, ...none }
    case 'object': {
      if (!isPlainObject(s.properties) || Object.keys(s.properties).length === 0) return { kind: 'json', ...none }
      return { kind: 'object', ...none }
    }
    case 'array': {
      if (!isPlainObject(s.items) && s.items !== undefined) return { kind: 'json', ...none } // tuple form
      if (s.prefixItems !== undefined) return { kind: 'json', ...none }
      const item = buildField('', [], s.items ?? {}, false, root, depth + 1)
      if (!PRIMITIVE_KINDS.includes(item.kind)) return { kind: 'json', ...none }
      return { kind: 'array', item }
    }
    default:
      return { kind: 'json', ...none }
  }
}

function buildField(key: string, path: string[], raw: unknown, required: boolean, root: JsonSchema, depth: number): SchemaField {
  const s = normalize(raw, root, depth)
  const base = {
    key,
    path,
    required,
    title: null as string | null,
    description: null as string | null,
    hasDefault: false,
    default: undefined as unknown,
    enumValues: [] as unknown[],
    format: null as string | null,
    constraints: [] as string[],
    item: null as SchemaField | null,
    fields: [] as SchemaField[],
  }
  if (!s) return { ...base, kind: 'json' }
  base.title = typeof s.title === 'string' && s.title.trim() ? s.title : null
  base.description = typeof s.description === 'string' && s.description.trim() ? s.description : null
  base.hasDefault = hasOwn(s, 'default')
  base.default = s.default
  base.format = typeof s.format === 'string' ? s.format : null
  base.constraints = constraintsOf(s)
  const k = kindOf(s, root, depth)
  // Deeply nested objects (often a recursive schema) are edited as JSON rather than as fieldsets in fieldsets.
  if (k.kind === 'object' && path.length > MAX_OBJECT_NESTING) return { ...base, kind: 'json' }
  const field: SchemaField = { ...base, kind: k.kind, item: k.item }
  if (k.kind === 'enum') field.enumValues = (s.enum as unknown[]).slice()
  if (k.kind === 'object') field.fields = objectFields(s, path, root, depth + 1)
  return field
}

function objectFields(s: JsonSchema, path: string[], root: JsonSchema, depth: number): SchemaField[] {
  const props = isPlainObject(s.properties) ? s.properties : {}
  const required = new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : [])
  return Object.entries(props).map(([key, sub]) => buildField(key, [...path, key], sub, required.has(key), root, depth))
}

/** The fields of an object schema (a tool's `inputSchema`), in schema order. Not an object schema: no fields. */
export function schemaFields(schema: unknown): SchemaField[] {
  if (!isPlainObject(schema)) return []
  const s = normalize(schema, schema, 0)
  if (!s || !isPlainObject(s.properties)) return []
  return objectFields(s, [], schema, 1)
}

// ---------------------------------------------------------------------------
// JSON text <-> values
// ---------------------------------------------------------------------------

// Placeholder shapes produced by jsonTemplate.substituteTokens.
const SUB_BARE = /^__SLINGER_BARE_(\d+)__$/
const SUB_ANY = /__SLINGER_(?:BARE|STR)_(\d+)__/g

function restoreTokens(v: unknown, tokens: string[]): unknown {
  if (typeof v === 'string') {
    const bare = SUB_BARE.exec(v)
    if (bare) return new BareToken(tokens[Number(bare[1])])
    return v.replace(SUB_ANY, (_m, n: string) => tokens[Number(n)])
  }
  if (Array.isArray(v)) return v.map((x) => restoreTokens(x, tokens))
  if (isPlainObject(v)) {
    // fromEntries defines own properties, so a "__proto__" key stays an ordinary key.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(SUB_ANY, (_m, n: string) => tokens[Number(n)]), restoreTokens(x, tokens)]))
  }
  return v
}

/** Any JSON value, `{{variables}}` allowed. Empty text: `value` undefined. */
export function parseJsonValue(text: string): JsonParse<unknown> {
  if (!text.trim()) return { ok: true, value: undefined }
  const sub = substituteTokens(text)
  try {
    return { ok: true, value: restoreTokens(JSON.parse(sub.text), sub.tokens) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
}

/** Tool arguments: a JSON object (empty text = `{}`). */
export function parseArguments(text: string): JsonParse<Json> {
  const r = parseJsonValue(text)
  if (!r.ok) return { ok: false, error: `The arguments are not valid JSON: ${r.error}` }
  if (r.value === undefined) return { ok: true, value: {} }
  if (!isPlainObject(r.value)) return { ok: false, error: 'The arguments must be a JSON object.' }
  return { ok: true, value: r.value }
}

const BARE_MARK = '\u0000slinger-bare:'
const BARE_OUT = /"\\u0000slinger-bare:(\d+)"/g

/** Pretty JSON (2 spaces) with bare tokens written unquoted. `undefined` -> ''. */
export function stringifyJson(value: unknown): string {
  if (value === undefined) return ''
  const tokens: string[] = []
  const text = JSON.stringify(value, (_k, v: unknown) => (v instanceof BareToken ? `${BARE_MARK}${tokens.push(v.raw) - 1}` : v), 2)
  return text.replace(BARE_OUT, (_m, n: string) => tokens[Number(n)])
}

export const stringifyArguments = (value: Json): string => stringifyJson(value)

// ---------------------------------------------------------------------------
// Reading and writing values
// ---------------------------------------------------------------------------

export function getAt(root: unknown, path: readonly string[]): unknown {
  let cur = root
  for (const k of path) {
    if (!isPlainObject(cur) || !hasOwn(cur, k)) return undefined
    cur = cur[k]
  }
  return cur
}

/** Sets (or with undefined removes) `key`, keeping the position of an existing key; a new key goes in `order`. */
function withKey(obj: Json, key: string, value: unknown, order: readonly string[]): Json {
  const entries = Object.entries(obj)
  const i = entries.findIndex(([k]) => k === key)
  if (value === undefined) {
    if (i >= 0) entries.splice(i, 1)
  } else if (i >= 0) {
    entries[i] = [key, value]
  } else {
    const pos = order.indexOf(key)
    let at = entries.length
    if (pos >= 0) {
      const later = new Set(order.slice(pos + 1))
      const j = entries.findIndex(([k]) => later.has(k))
      if (j >= 0) at = j
    }
    entries.splice(at, 0, [key, value])
  }
  return Object.fromEntries(entries)
}

/**
 * A copy of `root` with the value at `path` set (undefined removes it). Missing parent objects are created; a new key
 * is inserted before the first existing key that follows it in the schema (`fields`), else at the end.
 */
export function setAt(root: Json, fields: readonly SchemaField[], path: readonly string[], value: unknown): Json {
  const [key, ...rest] = path
  if (key === undefined) return root
  const field = fields.find((f) => f.key === key)
  const order = fields.map((f) => f.key)
  if (rest.length === 0) return withKey(root, key, value, order)
  const cur = hasOwn(root, key) ? root[key] : undefined
  if (!isPlainObject(cur) && value === undefined) return root
  return withKey(root, key, setAt(isPlainObject(cur) ? cur : {}, field?.fields ?? [], rest, value), order)
}

const wholeToken = (text: string): string | null => {
  const t = text.trim()
  const toks = parseTokens(t)
  return toks.length === 1 && toks[0].from === 0 && toks[0].to === t.length ? t : null
}
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

/** The text an input shows for a stored value. */
export function displayText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (value instanceof BareToken) return value.raw
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return stringifyJson(value)
}

/**
 * The value to store for an input's text. Empty -> undefined (the key is removed). Number / integer / boolean: a
 * valid literal is stored typed, a whole `{{variable}}` as a BareToken (with templates on); anything else is kept as
 * a string so the text is not lost, and `fieldProblem` reports it.
 */
export function readText(kind: FieldKind, text: string, templates = true): unknown {
  if (kind === 'string' || kind === 'enum') return text === '' ? undefined : text
  const t = text.trim()
  if (t === '') return undefined
  if (kind === 'number' || kind === 'integer') {
    if (templates && wholeToken(t)) return new BareToken(t)
    if (JSON_NUMBER.test(t)) return Number(t)
    return text
  }
  if (kind === 'boolean') {
    if (templates && wholeToken(t)) return new BareToken(t)
    if (t === 'true') return true
    if (t === 'false') return false
    return text
  }
  return text
}

/** Why a stored value does not fit its field, or null. */
export function fieldProblem(field: SchemaField, value: unknown, templates = true): string | null {
  if (value === undefined || value === null || value instanceof BareToken) return null
  const variable = templates ? ' or a {{variable}}' : ''
  const isTemplate = typeof value === 'string' && templates && wholeToken(value) !== null
  switch (field.kind) {
    case 'number':
      return typeof value === 'number' || isTemplate ? null : `Enter a number${variable}.`
    case 'integer':
      if (isTemplate) return null
      return typeof value === 'number' && Number.isInteger(value) ? null : `Enter a whole number${variable}.`
    case 'boolean':
      return typeof value === 'boolean' || isTemplate ? null : `Enter true or false${variable}.`
    case 'enum':
      return field.enumValues.some((e) => e === value) || isTemplate ? null : 'Not one of the allowed values.'
    default:
      return null
  }
}

/**
 * The kind to edit a stored value with: the field's kind when the value fits it, else `json` (so a value of an
 * unexpected type is shown as it is instead of being coerced).
 */
export function effectiveKind(field: SchemaField, value: unknown): FieldKind {
  if (value === undefined || value === null) return field.kind
  const bare = value instanceof BareToken
  switch (field.kind) {
    case 'string':
      return typeof value === 'string' || bare ? 'string' : 'json'
    case 'enum':
      return isPrimitive(value) || bare ? 'enum' : 'json'
    case 'number':
    case 'integer':
      return typeof value === 'number' || typeof value === 'string' || bare ? field.kind : 'json'
    case 'boolean':
      return typeof value === 'boolean' || typeof value === 'string' || bare ? 'boolean' : 'json'
    case 'array':
      return Array.isArray(value) && field.item && value.every((x) => x !== null && effectiveKind(field.item!, x) === field.item!.kind) ? 'array' : 'json'
    case 'object':
      return isPlainObject(value) ? 'object' : 'json'
    default:
      return 'json'
  }
}

/** The value a new array row starts with. */
export function newItemValue(item: SchemaField): unknown {
  if (item.hasDefault && isPrimitive(item.default) && item.default !== null) return item.default
  switch (item.kind) {
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'enum':
      return item.enumValues[0] ?? ''
    default:
      return ''
  }
}

/** Dotted paths of required fields that have no value (inside objects that are present). */
export function missingRequired(fields: readonly SchemaField[], value: unknown): string[] {
  const out: string[] = []
  for (const f of fields) {
    const v = getAt(value, [f.key])
    if (v === undefined) {
      if (f.required) out.push(f.path.join('.'))
    } else if (f.kind === 'object' && isPlainObject(v)) {
      out.push(...missingRequired(f.fields, v))
    }
  }
  return out
}

/** Top-level keys of the arguments that the schema does not describe (kept, edited in the JSON view). */
export function unknownKeys(fields: readonly SchemaField[], value: Json): string[] {
  const known = new Set(fields.map((f) => f.key))
  return Object.keys(value).filter((k) => !known.has(k))
}

const FORMAT_EXAMPLES: Record<string, string> = {
  'date-time': 'e.g. 2026-01-31T12:00:00Z',
  date: 'e.g. 2026-01-31',
  time: 'e.g. 12:00:00',
  email: 'e.g. name@example.com',
  uri: 'e.g. https://example.com',
  url: 'e.g. https://example.com',
  uuid: 'e.g. 7b9f4c6e-2a62-4f29-a97f-36a2f61c24d2',
}

/** Placeholder for an empty input: the default, else a format example, else what to type. */
export function placeholderFor(field: SchemaField, templates = true): string {
  if (field.hasDefault && field.default !== undefined && field.default !== null) {
    return `Default: ${typeof field.default === 'string' ? field.default : JSON.stringify(field.default)}`
  }
  if (field.format) return FORMAT_EXAMPLES[field.format] ?? field.format
  const variable = templates ? ' or {{variable}}' : ''
  if (field.kind === 'number') return `Number${variable}`
  if (field.kind === 'integer') return `Whole number${variable}`
  if (field.kind === 'boolean') return `true or false${variable}`
  return ''
}

/** Short type label shown next to a field name. */
export function typeLabel(field: SchemaField): string {
  switch (field.kind) {
    case 'string':
      return field.format ? `string, ${field.format}` : 'string'
    case 'enum':
      return 'choice'
    case 'array':
      return `list of ${field.item ? typeLabel(field.item) : 'values'}`
    case 'json':
      return 'JSON'
    default:
      return field.kind
  }
}
