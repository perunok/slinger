import { describe, expect, it } from 'vitest'
import { inputVariables, preview, pretty, responseValue } from './values'

const base = { status: 200, statusText: 'OK', durationMs: 12, bodyBase64: null, bodyByteLength: 9 }

describe('responseValue', () => {
  it('parses JSON bodies, keeps text, joins repeated headers', () => {
    const r = responseValue({
      ...base,
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Set-Cookie', value: 'a=1' },
        { key: 'Set-Cookie', value: 'b=2' },
      ],
      bodyText: '{"ok":true}',
    })
    expect(r).toEqual({ status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=1, b=2' }, body: { ok: true }, durationMs: 12, size: 9 })
    expect(responseValue({ ...base, headers: [], bodyText: 'hello' }).body).toBe('hello')
    expect(responseValue({ ...base, headers: [], bodyText: '' }).body).toBe('')
  })

  it('binary bodies come as base64; test results are counted', () => {
    const r = responseValue({ ...base, headers: [], bodyText: null, bodyBase64: 'AAE=' }, [{ status: 'passed' }, { status: 'failed' }, { status: 'passed' }])
    expect(r).toMatchObject({ body: null, bodyBase64: 'AAE=', tests: { passed: 2, failed: 1 } })
  })

  it('a header named __proto__ is just a header', () => {
    const r = responseValue({ ...base, headers: [{ key: '__proto__', value: 'x' }], bodyText: '' })
    expect(Object.getPrototypeOf(r.headers)).toBe(Object.prototype)
    expect(Object.keys(r.headers)).toEqual(['__proto__'])
  })
})

describe('inputVariables', () => {
  it('turns the fields of an object into variables', () => {
    expect(inputVariables({ id: 7, name: 'x', tags: ['a'], skip: undefined, nil: null })).toEqual({ id: '7', name: 'x', tags: '["a"]', nil: 'null' })
  })
  it('gives none for anything else', () => {
    for (const v of [null, undefined, 1, 'x', [1, 2]]) expect(inputVariables(v)).toEqual({})
  })
})

describe('preview / pretty', () => {
  it('shortens long values', () => {
    expect(preview({ a: 1 })).toBe('{"a":1}')
    expect(preview('x'.repeat(200), 10)).toBe(`"${'x'.repeat(8)}…`)
    expect(preview(undefined)).toBe('—')
    expect(pretty({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(pretty('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}\n… (20 more characters)`)
  })
})
