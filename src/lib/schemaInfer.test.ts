import { describe, expect, it } from 'vitest'
import { inferSchema, inferSchemaFromExamples, mergeSchemas, stringFormat } from './schemaInfer'

describe('inferSchema', () => {
  it('describes primitives, telling integers from other numbers', () => {
    expect(inferSchema(null)).toEqual({ type: 'null' })
    expect(inferSchema(true)).toEqual({ type: 'boolean' })
    expect(inferSchema(3)).toEqual({ type: 'integer' })
    expect(inferSchema(3.5)).toEqual({ type: 'number' })
    expect(inferSchema('hello')).toEqual({ type: 'string' })
  })

  it('detects string formats', () => {
    expect(stringFormat('2024-01-01T00:00:00Z')).toBe('date-time')
    expect(stringFormat('2024-01-01T10:20:30.123+02:00')).toBe('date-time')
    expect(stringFormat('2024-01-01')).toBe('date')
    expect(stringFormat('2024-13-45')).toBeNull()
    expect(stringFormat('user@example.com')).toBe('email')
    expect(stringFormat('00000000-0000-4000-8000-000000000000')).toBe('uuid')
    expect(stringFormat('https://example.com/a?b=c')).toBe('uri')
    expect(stringFormat('not an email @ all')).toBeNull()
    expect(stringFormat('12')).toBeNull()
    expect(inferSchema('user@example.com')).toEqual({ type: 'string', format: 'email' })
  })

  it('lists every key of an object as a required property', () => {
    expect(inferSchema({ id: 1, name: 'Rex', tags: ['a'] })).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'name', 'tags'],
    })
    expect(inferSchema({})).toEqual({ type: 'object' })
  })

  it('merges the items of an array, null included', () => {
    expect(inferSchema([])).toEqual({ type: 'array', items: {} })
    expect(inferSchema([1, 2.5])).toEqual({ type: 'array', items: { type: 'number' } })
    expect(inferSchema(['a', null])).toEqual({ type: 'array', items: { type: ['string', 'null'] } })
    expect(inferSchema([{ id: 1, name: 'a' }, { id: 2 }, { id: 3, name: null, extra: true }])).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: ['string', 'null'] }, extra: { type: 'boolean' } },
        required: ['id'],
      },
    })
  })

  it('looks at the first 50 elements only', () => {
    const list = [...Array.from({ length: 50 }, (_, i) => i), 'late string']
    expect(inferSchema(list)).toEqual({ type: 'array', items: { type: 'integer' } })
  })

  it('stops at a deep nesting level', () => {
    let deep: unknown = 1
    for (let i = 0; i < 100; i++) deep = [deep]
    expect(() => JSON.stringify(inferSchema(deep))).not.toThrow()
  })
})

describe('mergeSchemas', () => {
  it('joins types and keeps null last', () => {
    expect(mergeSchemas({ type: 'null' }, { type: 'integer' })).toEqual({ type: ['integer', 'null'] })
    expect(mergeSchemas({ type: 'integer' }, { type: 'number' })).toEqual({ type: 'number' })
    expect(mergeSchemas({ type: 'string' }, { type: 'boolean' })).toEqual({ type: ['string', 'boolean'] })
  })

  it('keeps a format only when both agree', () => {
    expect(mergeSchemas({ type: 'string', format: 'uuid' }, { type: 'string', format: 'uuid' })).toEqual({ type: 'string', format: 'uuid' })
    expect(mergeSchemas({ type: 'string', format: 'uuid' }, { type: 'string' })).toEqual({ type: 'string' })
    expect(mergeSchemas({ type: 'string', format: 'date' }, { type: 'null' })).toEqual({ type: ['string', 'null'], format: 'date' })
  })

  it('unions properties and intersects required keys', () => {
    const a = inferSchema({ id: 1, name: 'x' })
    const b = inferSchema({ id: 2.5, age: 3 })
    expect(mergeSchemas(a, b)).toEqual({
      type: 'object',
      properties: { id: { type: 'number' }, name: { type: 'string' }, age: { type: 'integer' } },
      required: ['id'],
    })
  })

  it('treats {} (an empty array\'s items) as unknown', () => {
    expect(mergeSchemas(inferSchema([]), inferSchema([1]))).toEqual({ type: 'array', items: { type: 'integer' } })
    expect(mergeSchemas({}, { type: 'string' })).toEqual({ type: 'string' })
  })

  it('combines an object with null or another type', () => {
    expect(mergeSchemas(inferSchema({ a: 1 }), { type: 'null' })).toEqual({
      type: ['object', 'null'],
      properties: { a: { type: 'integer' } },
      required: ['a'],
    })
    expect(inferSchemaFromExamples([{ a: 1 }, [1], 'x'])).toEqual({
      type: ['object', 'array', 'string'],
      properties: { a: { type: 'integer' } },
      required: ['a'],
      items: { type: 'integer' },
    })
    expect(inferSchemaFromExamples([])).toEqual({})
  })
})
