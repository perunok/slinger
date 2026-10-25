/**
 * Example values from JSON/OpenAPI schemas, for request bodies, parameters and saved examples of imported operations.
 * Deterministic on purpose (no random data): importing the same document twice gives the same requests, so "update from
 * the spec" only reports real changes. Explicit examples always win over generated ones.
 */
import { deref, isObj, type Json } from './load'

export interface SampleOptions {
  /** 'request': leave out readOnly properties; 'response': leave out writeOnly ones. */
  direction: 'request' | 'response'
}

const MAX_DEPTH = 8

const FORMATS: Record<string, unknown> = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  'idn-email': 'user@example.com',
  uuid: '00000000-0000-4000-8000-000000000000',
  uri: 'https://example.com',
  'uri-reference': '/example',
  url: 'https://example.com',
  hostname: 'example.com',
  'idn-hostname': 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'ZXhhbXBsZQ==',
  binary: '',
  password: 'password',
  int32: 0,
  int64: 0,
}

/** The first explicit example a schema carries (example, examples[0], default, const, enum[0]); undefined when none. */
export function explicitExample(schema: Json): unknown {
  if (schema.example !== undefined) return schema.example
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0]
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => v !== null) ?? schema.enum[0]
  return undefined
}

/** The schema's main type (3.1 type arrays: the first that is not "null"). */
export function schemaType(schema: Json): string | null {
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.type)) return (schema.type.find((t) => t !== 'null') as string | undefined) ?? (schema.type.includes('null') ? 'null' : null)
  if (isObj(schema.properties) || isObj(schema.additionalProperties)) return 'object'
  if (schema.items !== undefined) return 'array'
  return null
}

/** `allOf` parts merged into one schema (properties and required united); other keywords of the parts kept. */
export function mergeAllOf(doc: Json, schema: Json, seen: Set<unknown>): Json {
  if (!Array.isArray(schema.allOf)) return schema
  const { allOf, ...rest } = schema
  const merged: Json = { ...rest }
  const properties: Json = isObj(rest.properties) ? { ...rest.properties } : {}
  const required = new Set<string>(Array.isArray(rest.required) ? (rest.required as string[]) : [])
  for (const part of allOf as unknown[]) {
    if (isObj(part) && typeof part.$ref === 'string' && seen.has(part.$ref)) continue
    const p = mergeAllOf(doc, deref(doc, part), seen)
    for (const [k, v] of Object.entries(p)) {
      if (k === 'properties' && isObj(v)) Object.assign(properties, v)
      else if (k === 'required' && Array.isArray(v)) v.forEach((r) => required.add(String(r)))
      else if (merged[k] === undefined) merged[k] = v
    }
  }
  if (Object.keys(properties).length) merged.properties = properties
  if (required.size) merged.required = [...required]
  if (merged.type === undefined && Object.keys(properties).length) merged.type = 'object'
  return merged
}

/** An example value for `schema` (see the module comment). `seen` holds the refs on the current path (cycles stop). */
export function sampleFromSchema(schemaIn: unknown, doc: Json, opts: SampleOptions, depth = 0, seen: Set<unknown> = new Set()): unknown {
  const ref = isObj(schemaIn) && typeof schemaIn.$ref === 'string' ? schemaIn.$ref : null
  if (ref && seen.has(ref)) return undefined
  const path = ref ? new Set([...seen, ref]) : seen
  const schema = mergeAllOf(doc, deref(doc, schemaIn), path)
  const given = explicitExample(schema)
  if (given !== undefined) return given
  if (depth > MAX_DEPTH) return undefined
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[k]) && schema[k].length) {
      // The first alternative that is not just `null`.
      const alts = schema[k] as unknown[]
      const pick = alts.find((a) => schemaType(deref(doc, a)) !== 'null') ?? alts[0]
      return sampleFromSchema(pick, doc, opts, depth + 1, path)
    }
  }
  const type = schemaType(schema)
  switch (type) {
    case 'object': {
      const out: Json = {}
      const props = isObj(schema.properties) ? schema.properties : {}
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
      const keys = [...Object.keys(props).filter((k) => required.has(k)), ...Object.keys(props).filter((k) => !required.has(k))]
      for (const key of keys) {
        const prop = deref(doc, props[key])
        if (opts.direction === 'request' && prop.readOnly === true) continue
        if (opts.direction === 'response' && prop.writeOnly === true) continue
        const value = sampleFromSchema(props[key], doc, opts, depth + 1, path)
        if (value !== undefined) out[key] = value
      }
      return out
    }
    case 'array': {
      const item = sampleFromSchema(schema.items ?? {}, doc, opts, depth + 1, path)
      if (item === undefined) return []
      const n = Math.min(Math.max(typeof schema.minItems === 'number' ? schema.minItems : 1, 1), 3)
      return Array.from({ length: n }, () => item)
    }
    case 'string': {
      const format = typeof schema.format === 'string' ? schema.format : ''
      if (format in FORMATS) return FORMATS[format]
      const min = typeof schema.minLength === 'number' ? schema.minLength : 0
      const base = 'string'
      return min > base.length ? base.padEnd(Math.min(min, 1000), 'x') : base
    }
    case 'integer':
    case 'number': {
      let n = 0
      if (typeof schema.minimum === 'number') n = schema.minimum
      if (typeof schema.exclusiveMinimum === 'number') n = schema.exclusiveMinimum + (type === 'integer' ? 1 : 0.5)
      else if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') n = schema.minimum + (type === 'integer' ? 1 : 0.5)
      if (typeof schema.maximum === 'number' && n > schema.maximum) n = schema.maximum
      return type === 'integer' ? Math.ceil(n) : n
    }
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return isObj(schema.properties) ? sampleFromSchema({ ...schema, type: 'object' }, doc, opts, depth, path) : undefined
  }
}

/** A sample as text for a parameter value (`1`, `true`, `a,b` for arrays). */
export function sampleText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(sampleText).join(',')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
