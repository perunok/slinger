import { describe, expect, it } from 'vitest'
import {
  findSecretsUsed,
  findUnresolved,
  isBuiltin,
  makeScope,
  parseTokens,
  partialTokenBefore,
  previewValue,
  resolveTemplate,
  SECRET_MASK,
  tokenStatus,
} from './template'

const scope = makeScope('Staging', [
  { key: 'host', value: 'api.test', secret: false },
  { key: 'token', value: null, secret: true, id: 'v1' },
  { key: 'empty', value: '', secret: false },
])

describe('parseTokens', () => {
  it('finds tokens with offsets and trims whitespace', () => {
    const t = parseTokens('a {{ host }}/x/{{$guid}}?q={{a.b-c}}')
    expect(t.map((x) => x.name)).toEqual(['host', '$guid', 'a.b-c'])
    expect(t[0]).toMatchObject({ from: 2, to: 12, raw: '{{ host }}' })
  })
  it('ignores malformed braces', () => {
    expect(parseTokens('{{ }} {{a b}} {a} {{}}')).toEqual([])
    expect(parseTokens('{{{x}}}').map((x) => x.name)).toEqual(['x'])
  })
})

describe('status + preview', () => {
  it('classifies tokens', () => {
    expect(tokenStatus('host', scope)).toBe('resolved')
    expect(tokenStatus('token', scope)).toBe('secret')
    expect(tokenStatus('$timestamp', scope)).toBe('builtin')
    expect(tokenStatus('nope', scope)).toBe('unresolved')
    expect(isBuiltin('guid')).toBe(false)
  })
  it('masks secrets in previews', () => {
    expect(previewValue('token', scope)).toBe(SECRET_MASK)
    expect(previewValue('host', scope)).toBe('api.test')
    expect(previewValue('nope', scope)).toBeNull()
  })
})

describe('resolveTemplate', () => {
  it('resolves env variables, empty values and leaves unknown tokens', () => {
    expect(resolveTemplate('https://{{host}}/{{empty}}x/{{missing}}', scope)).toBe('https://api.test/x/{{missing}}')
  })
  it('uses provided secret values only', () => {
    expect(resolveTemplate('Bearer {{token}}', scope)).toBe('Bearer {{token}}')
    expect(resolveTemplate('Bearer {{token}}', scope, { secrets: new Map([['token', 's3cret']]) })).toBe('Bearer s3cret')
  })
  it('keeps builtins consistent through a cache', () => {
    const cache = new Map<string, string>()
    const out = resolveTemplate('{{$guid}}|{{$guid}}|{{$timestamp}}', scope, { builtinCache: cache, now: new Date(5000) })
    const [a, b, ts] = out.split('|')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(ts).toBe('5')
  })
  it('is a no-op without braces', () => {
    expect(resolveTemplate('plain', scope)).toBe('plain')
  })
})

describe('findUnresolved / findSecretsUsed', () => {
  it('lists unique unresolved names across texts', () => {
    expect(findUnresolved(['{{a}}{{host}}', '{{a}}{{b}}{{$guid}}'], scope)).toEqual(['a', 'b'])
  })
  it('finds secrets used', () => {
    expect(findSecretsUsed(['x {{token}} {{host}}'], scope).map((v) => v.id)).toEqual(['v1'])
  })
})

describe('partialTokenBefore', () => {
  it('detects an open token', () => {
    expect(partialTokenBefore('http://{{ho', 11)).toEqual({ from: 9, query: 'ho' })
    expect(partialTokenBefore('{{', 2)).toEqual({ from: 2, query: '' })
    expect(partialTokenBefore('{{done}} x', 10)).toBeNull()
  })
})
