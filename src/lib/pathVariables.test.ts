import { describe, expect, it } from 'vitest'
import { applyPathVariables, encodePathSegment, mergePathVariables, pathVariableNames } from './pathVariables'

const pv = (key: string, value = '', description = '') => ({ key, value, description })
const id = (t: string) => t

describe('pathVariableNames', () => {
  it('finds whole :name path segments, once each, in order', () => {
    expect(pathVariableNames('{{baseUrl}}/pets/:petId')).toEqual(['petId'])
    expect(pathVariableNames('https://api.test/users/:userId/posts/:postId')).toEqual(['userId', 'postId'])
    expect(pathVariableNames('/a/:x/b/:x')).toEqual(['x'])
    expect(pathVariableNames('/a/:x/')).toEqual(['x'])
  })

  it('ignores the host and port, ::, query, hash, partial segments and {{ }}', () => {
    expect(pathVariableNames('localhost:3000/pets')).toEqual([])
    expect(pathVariableNames('http://localhost:3000/pets')).toEqual([])
    expect(pathVariableNames('{{host}}:{{port}}/pets')).toEqual([])
    expect(pathVariableNames('http://h/a/::b')).toEqual([])
    expect(pathVariableNames('http://h/a?x=/:id#/:frag')).toEqual([])
    expect(pathVariableNames('http://h/a:b/x:y')).toEqual([])
    expect(pathVariableNames('http://h/:{{v}}')).toEqual([])
    expect(pathVariableNames('http://h/:')).toEqual([])
    expect(pathVariableNames('')).toEqual([])
  })
})

describe('mergePathVariables', () => {
  it('adds and removes rows with the URL, keeping values and descriptions by key', () => {
    const prev = [pv('a', '1', 'first'), pv('gone', '9')]
    expect(mergePathVariables('/x/:b/:a', prev)).toEqual([pv('b'), pv('a', '1', 'first')])
    expect(mergePathVariables('/x', prev)).toEqual([])
  })
})

describe('applyPathVariables', () => {
  it('replaces segments with the resolved, encoded value', () => {
    const r = applyPathVariables('{{baseUrl}}/pets/:petId/toys/:toy?q=:petId', [pv('petId', '{{id}}'), pv('toy', 'a b/c')], (t) => t.replace('{{id}}', '7'))
    expect(r).toEqual({ url: '{{baseUrl}}/pets/7/toys/a%20b%2Fc?q=:petId', missing: [] })
  })

  it('keeps :name when the value is empty or missing and reports it', () => {
    expect(applyPathVariables('http://h:8080/a/:x/:y/:x', [pv('x', '')], id)).toEqual({ url: 'http://h:8080/a/:x/:y/:x', missing: ['x', 'y'] })
  })

  it('leaves {{tokens}} in a value as they are (still reported as unresolved by the caller)', () => {
    expect(applyPathVariables('/a/:x', [pv('x', '{{secret}} 1')], id).url).toBe('/a/{{secret}}%201')
  })
})

describe('encodePathSegment', () => {
  it('encodes what breaks a segment, keeps valid escapes and unreserved text', () => {
    expect(encodePathSegment('a b?c#d/e')).toBe('a%20b%3Fc%23d%2Fe')
    expect(encodePathSegment('100%25')).toBe('100%25')
    expect(encodePathSegment('100%')).toBe('100%25')
    expect(encodePathSegment('ä-_.~:@!$')).toBe('%C3%A4-_.~:%40!$')
  })
})
