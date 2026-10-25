/**
 * JSON Schema inference from example JSON values, for the OpenAPI export (openapiExport.ts). Pure functions.
 *
 * Output is the JSON Schema 2020-12 dialect that OpenAPI 3.1 uses: `type` is a string, or an array when a value was seen
 * with several types (`['string', 'null']`). Keywords are type-scoped in JSON Schema, so one schema can carry `properties`
 * (objects), `items` (arrays) and `format` (strings) side by side without `anyOf`.
 *
 * Rules: objects list every key as a property and as required (merging examples keeps only the keys present in all of
 * them as required); arrays merge the schemas of their elements (the first 50); integers and other numbers are told
 * apart (a mix is `number`); strings get `format` date-time / date / email / uuid / uri when they look like one; an empty
 * array is `{type: 'array', items: {}}` and its `{}` items do not constrain a later merge.
 */

export type JsonSchema = { [key: string]: unknown }

/** Elements of an array that are looked at (large example bodies stay cheap). */
export const MAX_ARRAY_SAMPLES = 50
/** Nesting below this is described as `{}` (any value). */
const MAX_DEPTH = 32

const TYPE_ORDER = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'] as const
type JsonType = (typeof TYPE_ORDER)[number]

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const URI = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/

/** The `format` a string value looks like, or null. */
export function stringFormat(s: string): string | null {
  if (DATE_TIME.test(s) && !Number.isNaN(Date.parse(s.replace(' ', 'T')))) return 'date-time'
  if (DATE.test(s) && !Number.isNaN(Date.parse(s))) return 'date'
  if (UUID.test(s)) return 'uuid'
  if (EMAIL.test(s)) return 'email'
  if (URI.test(s)) return 'uri'
  return null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Schema of one JSON value. */
export function inferSchema(value: unknown, depth = 0): JsonSchema {
  // undefined (never in parsed JSON) marks a value that is not known, such as a `{{variable}}` in a JSON body.
  if (depth > MAX_DEPTH || value === undefined) return {}
  if (value === null) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' }
  if (typeof value === 'string') {
    const format = stringFormat(value)
    return format ? { type: 'string', format } : { type: 'string' }
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_SAMPLES).map((v) => inferSchema(v, depth + 1))
    return { type: 'array', items: items.length > 0 ? items.reduce(mergeSchemas) : {} }
  }
  if (isObj(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return { type: 'object' }
    const properties: Record<string, JsonSchema> = {}
    for (const k of keys) properties[k] = inferSchema(value[k], depth + 1)
    return { type: 'object', properties, required: keys }
  }
  return {}
}

/** Schema of several example values of the same thing (for example the bodies of two 200 examples). */
export function inferSchemaFromExamples(values: unknown[]): JsonSchema {
  return values.length === 0 ? {} : values.map((v) => inferSchema(v)).reduce(mergeSchemas)
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** A schema split by the type each keyword belongs to. */
interface Facets {
  types: Set<JsonType>
  properties: Record<string, JsonSchema> | null
  required: string[] | null
  items: JsonSchema | null
  /** undefined: no string seen; null: strings of different (or no) format. */
  format: string | null | undefined
  /** Keywords this module does not produce, kept from the first schema. */
  rest: JsonSchema
}

const isJsonType = (t: unknown): t is JsonType => typeof t === 'string' && (TYPE_ORDER as readonly string[]).includes(t)

function facets(s: JsonSchema): Facets {
  const raw = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type]
  const types = new Set(raw.filter(isJsonType))
  const { type: _t, properties, required, items, format, ...rest } = s
  return {
    types,
    properties: isObj(properties) ? (properties as Record<string, JsonSchema>) : null,
    required: Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : null,
    items: isObj(items) ? (items as JsonSchema) : null,
    format: types.has('string') ? (typeof format === 'string' ? format : null) : undefined,
    rest,
  }
}

const isEmpty = (s: JsonSchema) => Object.keys(s).length === 0

/**
 * One schema that accepts what either accepts, as inference would have produced from both examples: types are joined
 * (`integer` + `number` is `number`, anything + `null` is `[type, 'null']`), object properties are the union (merged
 * where both have them) and required keys the intersection, array items are merged, a string `format` survives only
 * when both agree. `{}` (nothing known, e.g. the items of an empty array) is the identity.
 */
export function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (isEmpty(a)) return b
  if (isEmpty(b)) return a
  const fa = facets(a)
  const fb = facets(b)
  // A schema without a known type (hand-written, or `{}`-like with other keywords): nothing sensible to merge.
  if (fa.types.size === 0 || fb.types.size === 0) return fa.types.size === 0 ? a : b

  const types = new Set<JsonType>([...fa.types, ...fb.types])
  if (types.has('number')) types.delete('integer')

  const out: JsonSchema = {}
  const ordered = TYPE_ORDER.filter((t) => types.has(t))
  out.type = ordered.length === 1 ? ordered[0] : ordered

  if (types.has('string')) {
    const format = fa.format === undefined ? fb.format : fb.format === undefined ? fa.format : fa.format === fb.format ? fa.format : null
    if (format) out.format = format
  }
  if (types.has('object')) {
    const pa = fa.types.has('object') ? (fa.properties ?? {}) : null
    const pb = fb.types.has('object') ? (fb.properties ?? {}) : null
    const props: Record<string, JsonSchema> = {}
    for (const [k, v] of Object.entries(pa ?? {})) props[k] = pb && k in pb ? mergeSchemas(v, pb[k]!) : v
    for (const [k, v] of Object.entries(pb ?? {})) if (!(k in props)) props[k] = v
    if (Object.keys(props).length > 0) out.properties = props
    // Only one side is an object: its required list stands (the other side is not an object at all).
    const ra = fa.types.has('object') ? (fa.required ?? []) : null
    const rb = fb.types.has('object') ? (fb.required ?? []) : null
    const required = ra && rb ? ra.filter((k) => rb.includes(k)) : (ra ?? rb ?? [])
    if (required.length > 0) out.required = required
  }
  if (types.has('array')) {
    const ia = fa.types.has('array') ? (fa.items ?? {}) : null
    const ib = fb.types.has('array') ? (fb.items ?? {}) : null
    out.items = ia && ib ? mergeSchemas(ia, ib) : (ia ?? ib ?? {})
  }
  return { ...fa.rest, ...out }
}
