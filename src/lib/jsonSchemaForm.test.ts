import { describe, expect, it } from 'vitest'
import {
  BareToken,
  displayText,
  effectiveKind,
  fieldProblem,
  getAt,
  missingRequired,
  newItemValue,
  parseArguments,
  parseJsonValue,
  placeholderFor,
  readText,
  schemaFields,
  setAt,
  stringifyArguments,
  stringifyJson,
  typeLabel,
  unknownKeys,
  type SchemaField,
} from './jsonSchemaForm'

const weather = {
  type: 'object',
  properties: {
    city: { type: 'string', enum: ['Paris', 'Oslo'], description: 'Which city' },
    units: { type: 'string', enum: ['metric', 'imperial'], default: 'metric' },
    days: { type: 'integer', minimum: 1, maximum: 7 },
    detailed: { type: 'boolean' },
  },
  required: ['city'],
}

const byKey = (fields: SchemaField[], key: string) => {
  const f = fields.find((x) => x.key === key)
  if (!f) throw new Error(`no field ${key}`)
  return f
}

describe('schemaFields', () => {
  it('maps properties to fields in schema order with required, descriptions, defaults and constraints', () => {
    const fields = schemaFields(weather)
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ['city', 'enum', true],
      ['units', 'enum', false],
      ['days', 'integer', false],
      ['detailed', 'boolean', false],
    ])
    expect(byKey(fields, 'city')).toMatchObject({ description: 'Which city', enumValues: ['Paris', 'Oslo'], path: ['city'] })
    expect(byKey(fields, 'units')).toMatchObject({ hasDefault: true, default: 'metric' })
    expect(byKey(fields, 'days').constraints).toEqual(['Minimum 1', 'Maximum 7'])
  })

  it('handles strings with formats, arrays of primitives and nested objects', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        when: { type: 'string', format: 'date-time', title: 'When' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        ids: { type: 'array', items: { type: 'integer' } },
        address: { type: 'object', properties: { street: { type: 'string' }, zip: { type: 'string' } }, required: ['zip'] },
      },
    })
    expect(byKey(fields, 'when')).toMatchObject({ kind: 'string', format: 'date-time', title: 'When' })
    expect(byKey(fields, 'tags')).toMatchObject({ kind: 'array', constraints: ['At least 1 items'] })
    expect(byKey(fields, 'tags').item?.kind).toBe('string')
    expect(byKey(fields, 'ids').item?.kind).toBe('integer')
    const address = byKey(fields, 'address')
    expect(address.kind).toBe('object')
    expect(address.fields.map((f) => [f.path, f.required])).toEqual([
      [['address', 'street'], false],
      [['address', 'zip'], true],
    ])
  })

  it('falls back to JSON for real unions, maps, arrays of objects, tuples and untyped values', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        any: { anyOf: [{ type: 'string' }, { type: 'object', properties: { a: { type: 'string' } } }] },
        multi: { type: ['string', 'number'] },
        map: { type: 'object', additionalProperties: { type: 'string' } },
        rows: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
        tuple: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
        free: {},
        objEnum: { enum: [{ a: 1 }] },
      },
    })
    expect(fields.map((f) => f.kind)).toEqual(Array(8).fill('json'))
  })

  it('unwraps "X or null" (pydantic Optional) and nullable type lists', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        limit: { anyOf: [{ type: 'integer' }, { type: 'null' }], default: null, description: 'Max rows' },
        name: { type: ['string', 'null'] },
        mode: { oneOf: [{ type: 'null' }, { enum: ['a', 'b'] }] },
      },
    })
    expect(fields.map((f) => f.kind)).toEqual(['integer', 'string', 'enum'])
    expect(byKey(fields, 'limit').description).toBe('Max rows')
  })

  it('resolves local $refs (with sibling keys winning), allOf and const', () => {
    const fields = schemaFields({
      type: 'object',
      $defs: { Unit: { type: 'string', enum: ['c', 'f'], description: 'inner' }, Base: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
      properties: {
        unit: { $ref: '#/$defs/Unit', description: 'outer' },
        merged: { allOf: [{ $ref: '#/$defs/Base' }, { properties: { b: { type: 'number' } } }] },
        legacy: { $ref: '#/definitions/Missing' },
        fixed: { const: 'v1' },
      },
    })
    expect(byKey(fields, 'unit')).toMatchObject({ kind: 'enum', description: 'outer', enumValues: ['c', 'f'] })
    const merged = byKey(fields, 'merged')
    expect(merged.kind).toBe('object')
    expect(merged.fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ['a', 'string', true],
      ['b', 'number', false],
    ])
    expect(byKey(fields, 'legacy').kind).toBe('json')
    expect(byKey(fields, 'fixed')).toMatchObject({ kind: 'enum', enumValues: ['v1'] })
  })

  it('stops at recursive schemas instead of looping', () => {
    const fields = schemaFields({
      type: 'object',
      $defs: { Node: { type: 'object', properties: { value: { type: 'string' }, next: { $ref: '#/$defs/Node' } } } },
      properties: { head: { $ref: '#/$defs/Node' }, self: { $ref: '#' } },
    })
    let f = byKey(fields, 'head')
    let depth = 0
    while (f.kind === 'object') {
      f = byKey(f.fields, 'next')
      depth++
    }
    expect(f.kind).toBe('json')
    expect(depth).toBeLessThanOrEqual(5)
  })

  it('returns no fields for schemas without properties or that are not objects', () => {
    expect(schemaFields({ type: 'object' })).toEqual([])
    expect(schemaFields(null)).toEqual([])
    expect(schemaFields('x')).toEqual([])
    expect(schemaFields({ properties: { a: { type: 'string' } } }).map((f) => f.key)).toEqual(['a'])
  })
})

describe('parseArguments / stringifyArguments', () => {
  it('treats empty text as {} and rejects invalid JSON or non-objects', () => {
    expect(parseArguments('')).toEqual({ ok: true, value: {} })
    expect(parseArguments('  ')).toEqual({ ok: true, value: {} })
    expect(parseArguments('{"a":').ok).toBe(false)
    expect(parseArguments('[1]')).toEqual({ ok: false, error: 'The arguments must be a JSON object.' })
  })

  it('reads bare tokens as BareToken and keeps tokens inside strings and keys', () => {
    const r = parseArguments('{"n": {{count}}, "s": "a {{x}} b", "{{k}}-x": 1, "list": [{{a}}, "{{b}}"]}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.n).toEqual(new BareToken('{{count}}'))
    expect(r.value.s).toBe('a {{x}} b')
    expect(r.value['{{k}}-x']).toBe(1)
    expect(r.value.list).toEqual([new BareToken('{{a}}'), '{{b}}'])
  })

  it('round-trips text with unknown keys, key order and tokens (pretty printed)', () => {
    const text = '{"zeta": 1, "city": "Paris", "n": {{n}}, "extra": {"deep": [true, null]}, "s": "{{x}}"}'
    const r = parseArguments(text)
    if (!r.ok) throw new Error(r.error)
    expect(stringifyArguments(r.value)).toBe(
      '{\n  "zeta": 1,\n  "city": "Paris",\n  "n": {{n}},\n  "extra": {\n    "deep": [\n      true,\n      null\n    ]\n  },\n  "s": "{{x}}"\n}',
    )
    const again = parseArguments(stringifyArguments(r.value))
    expect(again).toEqual(r)
  })

  it('keeps a "__proto__" key as plain data', () => {
    const r = parseArguments('{"__proto__": {"polluted": 1}}')
    if (!r.ok) throw new Error(r.error)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(r.value)).toEqual(['__proto__'])
    expect(stringifyArguments(r.value)).toBe('{\n  "__proto__": {\n    "polluted": 1\n  }\n}')
  })

  it('stringifies {} compactly and undefined as empty text', () => {
    expect(stringifyArguments({})).toBe('{}')
    expect(stringifyJson(undefined)).toBe('')
    expect(stringifyJson(new BareToken('{{v}}'))).toBe('{{v}}')
  })

  it('parseJsonValue accepts any JSON value and empty text', () => {
    expect(parseJsonValue('')).toEqual({ ok: true, value: undefined })
    expect(parseJsonValue('[1, {{x}}]')).toEqual({ ok: true, value: [1, new BareToken('{{x}}')] })
    expect(parseJsonValue('"s"')).toEqual({ ok: true, value: 's' })
    expect(parseJsonValue('{').ok).toBe(false)
  })
})

describe('setAt / getAt', () => {
  const fields = schemaFields({
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'string' },
      c: { type: 'string' },
      obj: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } },
    },
  })

  it('replaces an existing key in place', () => {
    const next = setAt({ c: '1', zz: 0, a: '2' }, fields, ['a'], 'new')
    expect(Object.entries(next)).toEqual([
      ['c', '1'],
      ['zz', 0],
      ['a', 'new'],
    ])
  })

  it('inserts a new key before the next schema key present, else at the end', () => {
    expect(Object.keys(setAt({ zz: 0, c: '1' }, fields, ['b'], 'v'))).toEqual(['zz', 'b', 'c'])
    expect(Object.keys(setAt({ a: '1', zz: 0 }, fields, ['c'], 'v'))).toEqual(['a', 'zz', 'c'])
    expect(Object.keys(setAt({ zz: 0 }, fields, ['unknown'], 'v'))).toEqual(['zz', 'unknown'])
  })

  it('removes a key with undefined and does not touch the input', () => {
    const input = { a: '1', b: '2' }
    expect(setAt(input, fields, ['a'], undefined)).toEqual({ b: '2' })
    expect(input).toEqual({ a: '1', b: '2' })
  })

  it('creates missing parents for nested values and keeps nested key order', () => {
    expect(setAt({ a: '1' }, fields, ['obj', 'y'], 'v')).toEqual({ a: '1', obj: { y: 'v' } })
    const next = setAt({ obj: { y: '1', extra: true } }, fields, ['obj', 'x'], 'v')
    expect(Object.keys(next.obj as object)).toEqual(['x', 'y', 'extra'])
    expect(getAt(next, ['obj', 'x'])).toBe('v')
    expect(getAt(next, ['obj', 'missing'])).toBeUndefined()
    expect(getAt(next, ['a', 'b'])).toBeUndefined()
  })

  it('does not create a parent just to remove something from it', () => {
    expect(setAt({ a: '1' }, fields, ['obj', 'x'], undefined)).toEqual({ a: '1' })
  })

  it('replaces a non-object parent when setting into it', () => {
    expect(setAt({ obj: 'oops' }, fields, ['obj', 'x'], 'v')).toEqual({ obj: { x: 'v' } })
  })
})

describe('readText / displayText', () => {
  it('strings: kept as typed; empty removes the key', () => {
    expect(readText('string', ' a {{x}} ')).toBe(' a {{x}} ')
    expect(readText('string', '')).toBeUndefined()
    expect(readText('enum', 'Paris')).toBe('Paris')
  })

  it('numbers: JSON literals typed, whole templates bare, anything else kept as text', () => {
    expect(readText('number', '1.5')).toBe(1.5)
    expect(readText('number', ' -2e3 ')).toBe(-2000)
    expect(readText('integer', '42')).toBe(42)
    expect(readText('number', '{{n}}')).toEqual(new BareToken('{{n}}'))
    expect(readText('number', ' {{ n }} ')).toEqual(new BareToken('{{ n }}'))
    expect(readText('number', '1.')).toBe('1.')
    expect(readText('number', '0x10')).toBe('0x10')
    expect(readText('number', '1{{n}}')).toBe('1{{n}}')
    expect(readText('number', '   ')).toBeUndefined()
    expect(readText('number', '{{n}}', false)).toBe('{{n}}')
  })

  it('booleans: true/false typed, whole templates bare', () => {
    expect(readText('boolean', 'true')).toBe(true)
    expect(readText('boolean', 'false')).toBe(false)
    expect(readText('boolean', '{{flag}}')).toEqual(new BareToken('{{flag}}'))
    expect(readText('boolean', 'yes')).toBe('yes')
  })

  it('writes a whole-value template in a number field as a bare token in the JSON text', () => {
    const fields = schemaFields(weather)
    const next = setAt({ city: 'Paris' }, fields, ['days'], readText('integer', '{{days}}'))
    expect(stringifyArguments(next)).toBe('{\n  "city": "Paris",\n  "days": {{days}}\n}')
    expect(stringifyArguments(setAt(next, fields, ['detailed'], readText('boolean', '{{d}}')))).toBe(
      '{\n  "city": "Paris",\n  "days": {{days}},\n  "detailed": {{d}}\n}',
    )
  })

  it('displays stored values as input text', () => {
    expect(displayText(undefined)).toBe('')
    expect(displayText(null)).toBe('')
    expect(displayText('a')).toBe('a')
    expect(displayText(3)).toBe('3')
    expect(displayText(false)).toBe('false')
    expect(displayText(new BareToken('{{n}}'))).toBe('{{n}}')
  })
})

describe('fieldProblem / effectiveKind', () => {
  const fields = schemaFields({
    type: 'object',
    properties: {
      n: { type: 'number' },
      i: { type: 'integer' },
      b: { type: 'boolean' },
      e: { enum: ['x', 'y'] },
      s: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      obj: { type: 'object', properties: { a: { type: 'string' } } },
    },
  })
  const f = (k: string) => byKey(fields, k)

  it('reports values that do not fit, accepting templates', () => {
    expect(fieldProblem(f('n'), 1)).toBeNull()
    expect(fieldProblem(f('n'), '1.')).toBe('Enter a number or a {{variable}}.')
    expect(fieldProblem(f('n'), '1.', false)).toBe('Enter a number.')
    expect(fieldProblem(f('n'), '{{n}}')).toBeNull()
    expect(fieldProblem(f('n'), '{{n}}', false)).toBe('Enter a number.')
    expect(fieldProblem(f('n'), new BareToken('{{n}}'))).toBeNull()
    expect(fieldProblem(f('i'), 1.5)).toBe('Enter a whole number or a {{variable}}.')
    expect(fieldProblem(f('b'), 'yes')).toBe('Enter true or false or a {{variable}}.')
    expect(fieldProblem(f('e'), 'z')).toBe('Not one of the allowed values.')
    expect(fieldProblem(f('e'), 'y')).toBeNull()
    expect(fieldProblem(f('s'), 'anything')).toBeNull()
    expect(fieldProblem(f('n'), undefined)).toBeNull()
  })

  it('edits a value of an unexpected type as JSON instead of coercing it', () => {
    expect(effectiveKind(f('s'), 'x')).toBe('string')
    expect(effectiveKind(f('s'), 5)).toBe('json')
    expect(effectiveKind(f('n'), 'oops')).toBe('number')
    expect(effectiveKind(f('n'), true)).toBe('json')
    expect(effectiveKind(f('b'), 1)).toBe('json')
    expect(effectiveKind(f('tags'), ['a', 'b'])).toBe('array')
    expect(effectiveKind(f('tags'), ['a', { x: 1 }])).toBe('json')
    expect(effectiveKind(f('tags'), 'a')).toBe('json')
    expect(effectiveKind(f('obj'), { a: '1' })).toBe('object')
    expect(effectiveKind(f('obj'), [1])).toBe('json')
    expect(effectiveKind(f('obj'), new BareToken('{{o}}'))).toBe('json')
    expect(effectiveKind(f('e'), { a: 1 })).toBe('json')
    expect(effectiveKind(f('n'), undefined)).toBe('number')
  })
})

describe('helpers', () => {
  it('missingRequired lists required fields without a value, inside present objects', () => {
    const fields = schemaFields({
      type: 'object',
      properties: { a: { type: 'string' }, o: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
      required: ['a'],
    })
    expect(missingRequired(fields, {})).toEqual(['a'])
    expect(missingRequired(fields, { a: '1', o: {} })).toEqual(['o.x'])
    expect(missingRequired(fields, { a: '', o: { x: '1' } })).toEqual([])
  })

  it('unknownKeys lists top-level keys the schema does not describe', () => {
    expect(unknownKeys(schemaFields(weather), { zeta: 1, city: 'Oslo', other: 2 })).toEqual(['zeta', 'other'])
  })

  it('newItemValue starts rows with the item default or an empty value of its type', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        s: { type: 'array', items: { type: 'string' } },
        n: { type: 'array', items: { type: 'number' } },
        b: { type: 'array', items: { type: 'boolean' } },
        e: { type: 'array', items: { enum: ['x', 'y'] } },
        d: { type: 'array', items: { type: 'integer', default: 5 } },
      },
    })
    expect(fields.map((f) => newItemValue(f.item!))).toEqual(['', 0, false, 'x', 5])
  })

  it('placeholders show the default, a format example or what to type', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        d: { type: 'string', default: 'metric' },
        o: { type: 'object', properties: { a: { type: 'string' } }, default: { a: '1' } },
        f: { type: 'string', format: 'email' },
        g: { type: 'string', format: 'hostname' },
        n: { type: 'number' },
        i: { type: 'integer' },
        b: { type: 'boolean' },
        s: { type: 'string' },
      },
    })
    expect(fields.map((f) => placeholderFor(f))).toEqual([
      'Default: metric',
      'Default: {"a":"1"}',
      'e.g. name@example.com',
      'hostname',
      'Number or {{variable}}',
      'Whole number or {{variable}}',
      'true or false or {{variable}}',
      '',
    ])
    expect(placeholderFor(byKey(fields, 'n'), false)).toBe('Number')
  })

  it('typeLabel names the type', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        s: { type: 'string', format: 'uri' },
        e: { enum: ['a'] },
        l: { type: 'array', items: { type: 'integer' } },
        j: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        o: { type: 'object', properties: { a: { type: 'string' } } },
      },
    })
    expect(fields.map(typeLabel)).toEqual(['string, uri', 'choice', 'list of integer', 'JSON', 'object'])
  })
})
