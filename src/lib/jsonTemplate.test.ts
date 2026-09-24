import { describe, expect, it } from 'vitest'
import { beautifyJson, checkJson } from './jsonTemplate'

describe('checkJson', () => {
  it('accepts tokens as values and inside strings', () => {
    expect(checkJson('{"a": {{x}}, "b": "pre {{y}} post", "c": [{{z}}, 1]}')).toEqual({ ok: true })
  })
  it('treats empty as ok and reports real errors', () => {
    expect(checkJson('  ')).toEqual({ ok: true })
    const r = checkJson('{"a": }')
    expect(r.ok).toBe(false)
  })
  it('does not treat braces in strings as tokens', () => {
    expect(checkJson('{"a": "{ not a token }"}')).toEqual({ ok: true })
  })
})

describe('beautifyJson', () => {
  it('formats and restores tokens exactly', () => {
    const r = beautifyJson('{"a":{{x}},"b":"v-{{y}}","c":[1,{{$guid}}]}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('{\n  "a": {{x}},\n  "b": "v-{{y}}",\n  "c": [\n    1,\n    {{$guid}}\n  ]\n}')
  })
  it('fails without touching text on invalid JSON', () => {
    const r = beautifyJson('{"a":')
    expect(r.ok).toBe(false)
  })
})
