import { describe, expect, it } from 'vitest'
import { columnsFromPostman, postmanDescription, readDescription, writeDescription } from './description'
import { draftFingerprint, parseDocument, serializeDraft } from './request'

const req = (description: unknown) => ({
  name: 'R',
  method: 'GET',
  url: 'http://x',
  documentJson: JSON.stringify({ name: 'R', method: 'GET', url: 'http://x', description, headers: [], body: null, auth: null }),
})

describe('readDescription', () => {
  it('reads strings, {content, type} objects and junk', () => {
    expect(readDescription('# Hi')).toEqual({ text: '# Hi', format: 'markdown' })
    expect(readDescription({ content: 'a', type: 'text/markdown' })).toEqual({ text: 'a', format: 'markdown' })
    expect(readDescription({ content: 'a', type: 'text/plain' })).toEqual({ text: 'a', format: 'plain' })
    expect(readDescription({ content: 'a' })).toEqual({ text: 'a', format: 'markdown' })
    for (const v of [null, undefined, 42, [], {}]) expect(readDescription(v).text).toBe('')
  })
})

describe('writeDescription', () => {
  it('returns the original value untouched when the text did not change', () => {
    const obj = { content: 'x', type: 'text/plain', version: '1' }
    expect(writeDescription(obj, 'x')).toBe(obj)
    expect(writeDescription('x', 'x')).toBe('x')
    expect(writeDescription(null, '')).toBeNull()
    expect(writeDescription(undefined, '')).toBeNull()
  })
  it('writes edits as a string, keeping an object shape (and its type) when there was one', () => {
    expect(writeDescription('x', 'y')).toBe('y')
    expect(writeDescription(null, 'y')).toBe('y')
    expect(writeDescription({ content: 'x', type: 'text/plain' }, 'y')).toEqual({ content: 'y', type: 'text/plain' })
    expect(writeDescription({ content: 'x', type: 'text/plain' }, '')).toBeNull()
  })
})

describe('collection/folder columns', () => {
  it('maps Postman values to columns and back', () => {
    expect(columnsFromPostman('# A')).toEqual({ description: '# A', descriptionType: null })
    expect(columnsFromPostman({ content: 'p', type: 'text/plain' })).toEqual({ description: 'p', descriptionType: 'text/plain' })
    expect(columnsFromPostman({ content: 'm', type: 'weird' })).toEqual({ description: 'm', descriptionType: 'text/markdown' })
    expect(columnsFromPostman('  ')).toEqual({ description: null, descriptionType: null })
    expect(columnsFromPostman(undefined)).toEqual({ description: null, descriptionType: null })
    expect(postmanDescription('# A', null)).toBe('# A')
    expect(postmanDescription('p', 'text/plain')).toEqual({ content: 'p', type: 'text/plain' })
    expect(postmanDescription(null, null)).toBeUndefined()
    expect(postmanDescription('', 'text/plain')).toBeUndefined()
  })
})

describe('request documents', () => {
  it('keep an untouched object description byte-identical through parse + serialize', () => {
    for (const d of [{ content: '## Docs\n\n- a', type: 'text/markdown' }, { content: 'plain <b>', type: 'text/plain' }, 'string docs', null]) {
      const r = req(d)
      const draft = parseDocument(r)
      expect(JSON.parse(serializeDraft(draft).documentJson).description).toEqual(d)
      expect(draftFingerprint(draft)).toBe(draftFingerprint(parseDocument(r)))
    }
  })
  it('an edit to a text/plain object keeps its type; an edit to a string stays a string', () => {
    const plain = parseDocument(req({ content: 'a', type: 'text/plain' }))
    plain.description = 'b'
    expect(JSON.parse(serializeDraft(plain).documentJson).description).toEqual({ content: 'b', type: 'text/plain' })
    const str = parseDocument(req('a'))
    str.description = '# b'
    expect(JSON.parse(serializeDraft(str).documentJson).description).toBe('# b')
    str.description = ''
    expect(JSON.parse(serializeDraft(str).documentJson).description).toBeNull()
  })
})
