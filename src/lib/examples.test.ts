import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiRequest } from '../../shared/types'
import { createMockBackend } from '../dev/mockBackend'
import {
  BODY_ENCODING_KEY,
  EXAMPLE_BODY_LIMIT,
  blankExample,
  duplicateExample,
  exampleFingerprint,
  exampleFromResponse,
  exampleResponseData,
  exampleSummaries,
  locateExample,
  locatorFor,
  parseExample,
  readExamples,
  serializeExample,
  statusReason,
  updateExamples,
} from './examples'
import { newRow } from './kv'
import { buildPostmanCollection } from './postman'
import { newDraft, parseDocument } from './request'
import { analyzeResponse } from './response'

const SAMPLE = join(__dirname, '..', '..', 'example-postman-collection.json')

/** An example with every Postman v2.1 field plus unknown keys. */
const FULL = {
  id: 'ex-1',
  name: 'Created',
  originalRequest: {
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json', type: 'text' }, { key: 'X-Off', value: '1', disabled: true }],
    body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
    url: {
      raw: '{{base}}/items/:id?q=1',
      host: ['{{base}}'],
      path: ['items', ':id'],
      query: [{ key: 'q', value: '1' }, { key: 'off', value: 'x', disabled: true }],
      variable: [{ key: 'id', value: '7' }],
    },
    description: 'orig description',
    proxy: { host: 'p' },
  },
  status: 'Created',
  code: 201,
  _postman_previewlanguage: 'json',
  header: [
    { key: 'Content-Type', value: 'application/json', name: 'Content-Type', description: 'mime' },
    { key: 'X-Rate', value: '10' },
  ],
  cookie: [{ domain: 'example.com', key: 'sid', value: 'abc', path: '/', httpOnly: true }],
  responseTime: 42,
  timings: { total: 42 },
  body: '{"id":7,"a":1}',
  somethingElse: [1, 2, 3],
}

const parent = (docExtra: Record<string, unknown> = {}): Pick<ApiRequest, 'id' | 'method' | 'url' | 'documentJson'> => ({
  id: 'req-1',
  method: 'GET',
  url: 'https://parent.example/x',
  documentJson: JSON.stringify({ method: 'GET', url: 'https://parent.example/x', headers: [{ key: 'P', value: '1' }], body: null, responses: [FULL], ...docExtra }),
})

function editDraft(example: unknown) {
  const baseline = parseExample(example, parent())
  const edited = parseExample(example, parent())
  return { baseline, edited }
}

describe('parseExample', () => {
  it('reads every field', () => {
    const p = parseExample(FULL, parent())
    expect(p.response).toMatchObject({ name: 'Created', code: 201, status: 'Created', body: '{"id":7,"a":1}', language: 'json', bodyEncoding: null })
    expect(p.response.headers.filter((h) => h.key).map((h) => [h.key, h.value, h.description])).toEqual([
      ['Content-Type', 'application/json', 'mime'],
      ['X-Rate', '10', ''],
    ])
    expect(p.requestFromParent).toBe(false)
    expect(p.responseTime).toBe(42)
    expect(p.request.method).toBe('POST')
    expect(p.request.url).toBe('{{base}}/items/:id?q=1')
    expect(p.request.headers.filter((h) => h.key).map((h) => [h.key, h.enabled])).toEqual([['Content-Type', true], ['X-Off', false]])
    expect(p.request.params.filter((r) => r.key).map((r) => [r.key, r.value, r.enabled])).toEqual([['q', '1', true], ['off', 'x', false]])
    expect(p.request.body).toMatchObject({ kind: 'raw', raw: '{"a":1}', rawLanguage: 'json' })
    expect(p.request.description).toBe('orig description')
    expect(p.request.extras).toEqual({})
  })

  it('tolerates missing and odd fields', () => {
    const p = parseExample({ header: 'Content-Type: text/plain\nX-A: b', code: '404' }, parent())
    expect(p.response).toMatchObject({ name: '', code: 404, status: '', body: '', language: '' })
    expect(p.response.headers.filter((h) => h.key).map((h) => [h.key, h.value])).toEqual([['Content-Type', 'text/plain'], ['X-A', 'b']])
    // No originalRequest: the parent request is shown, without its scripts/responses.
    expect(p.requestFromParent).toBe(true)
    expect(p.request.url).toBe('https://parent.example/x')
    expect(p.request.headers.filter((h) => h.key).map((h) => h.key)).toEqual(['P'])
    expect(p.request.extras).toEqual({})
    expect(parseExample(null, parent()).response.name).toBe('')
    expect(parseExample({ body: { not: 'a string' } }, parent()).response.body).toContain('"not"')
    expect(parseExample({ originalRequest: 'https://s.example/a' }, parent()).request).toMatchObject({ method: 'GET', url: 'https://s.example/a' })
  })
})

describe('serializeExample', () => {
  it('writes an unedited example back byte for byte', () => {
    const { baseline, edited } = editDraft(FULL)
    expect(JSON.stringify(serializeExample(FULL, baseline, { response: edited.response, request: edited.request }))).toBe(JSON.stringify(FULL))
    const odd = { header: 'A: 1', code: '404', body: null, whatever: true }
    const p = parseExample(odd, parent())
    expect(serializeExample(odd, p, { response: parseExample(odd, parent()).response, request: parseExample(odd, parent()).request })).toEqual(odd)
  })

  it('changes only the edited response fields', () => {
    const { baseline, edited } = editDraft(FULL)
    edited.response.name = 'Renamed'
    edited.response.code = 202
    edited.response.status = 'Accepted'
    edited.response.body = '{}'
    const out = serializeExample(FULL, baseline, { response: edited.response, request: edited.request })
    expect(out).toEqual({ ...FULL, name: 'Renamed', code: 202, status: 'Accepted', body: '{}' })
    expect(Object.keys(out)).toEqual(Object.keys(FULL)) // key order kept
  })

  it('rewrites headers keeping extra keys of unchanged rows', () => {
    const { baseline, edited } = editDraft(FULL)
    edited.response.headers = [...edited.response.headers.filter((h) => h.key), newRow({ key: 'X-New', value: 'n', enabled: false })]
    edited.response.headers[1] = { ...edited.response.headers[1], value: '11' }
    const out = serializeExample(FULL, baseline, { response: edited.response, request: edited.request })
    expect(out.header).toEqual([
      { key: 'Content-Type', value: 'application/json', name: 'Content-Type', description: 'mime' },
      { key: 'X-Rate', value: '11' },
      { key: 'X-New', value: 'n', disabled: true },
    ])
    expect(out.originalRequest).toBe(FULL.originalRequest)
  })

  it('rebuilds originalRequest when its parts are edited, keeping unknown keys and path variables', () => {
    const { baseline, edited } = editDraft(FULL)
    edited.request.url = '{{base}}/items/:id?q=2'
    edited.request.params = edited.request.params.map((r) => (r.key === 'q' ? { ...r, value: '2' } : r))
    const out = serializeExample(FULL, baseline, { response: edited.response, request: edited.request })
    const req = out.originalRequest as Record<string, any>
    expect(req.url.raw).toBe('{{base}}/items/:id?q=2')
    expect(req.url.query).toEqual([{ key: 'q', value: '2' }, { key: 'off', value: 'x', disabled: true }])
    expect(req.url.variable).toEqual([{ key: 'id', value: '7' }])
    expect(req.proxy).toEqual({ host: 'p' })
    expect(req.method).toBe('POST')
    // Rebuilt rows follow the request serializer (type: 'text').
    expect(req.header).toEqual([{ key: 'Content-Type', value: 'application/json', type: 'text' }, { key: 'X-Off', value: '1', type: 'text', disabled: true }])
    expect(req.body).toEqual({ mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } })
    expect(req.description).toBe('orig description')
    // Everything else untouched.
    expect({ ...out, originalRequest: null }).toEqual({ ...FULL, originalRequest: null })
  })

  it('adds originalRequest to an example that had none only when the request part is edited', () => {
    const bare = { name: 'bare', code: 200, body: 'x' }
    const p = parseExample(bare, parent())
    const e = parseExample(bare, parent())
    expect(serializeExample(bare, p, { response: e.response, request: e.request })).toEqual(bare)
    e.request.method = 'DELETE'
    const out = serializeExample(bare, p, { response: e.response, request: e.request })
    expect(out.originalRequest).toMatchObject({ method: 'DELETE', url: { raw: 'https://parent.example/x' }, header: [{ key: 'P', value: '1' }] })
  })

  it('fingerprints the response half for dirty tracking', () => {
    const a = parseExample(FULL, parent()).response
    const b = parseExample(FULL, parent()).response
    expect(exampleFingerprint(a)).toBe(exampleFingerprint(b))
    b.body = 'changed'
    expect(exampleFingerprint(a)).not.toBe(exampleFingerprint(b))
  })
})

describe('documents and locating', () => {
  it('reads and replaces responses without touching other keys', () => {
    const doc = JSON.stringify({ name: 'r', responses: [FULL], scripts: [1] })
    expect(readExamples(doc)).toEqual([FULL])
    expect(readExamples('not json')).toEqual([])
    const next = updateExamples(doc, (l) => [...l, { name: 'b' }])
    expect(Object.keys(JSON.parse(next))).toEqual(['name', 'responses', 'scripts'])
    expect(readExamples(next)).toHaveLength(2)
    expect(JSON.parse(updateExamples('{"a":1}', () => [{ name: 'x' }]))).toEqual({ a: 1, responses: [{ name: 'x' }] })
  })

  it('summarises examples for the tree', () => {
    const r = { id: 'q', documentJson: JSON.stringify({ responses: [FULL, { name: ' ', code: 'x' }] }) }
    expect(exampleSummaries(r)).toEqual([
      { index: 0, name: 'Created', code: 201, id: 'ex-1' },
      { index: 1, name: 'Untitled example', code: null, id: null },
    ])
    expect(exampleSummaries({ id: 'z', documentJson: '{"headers":[]}' })).toEqual([])
  })

  it('finds an example after others were added, removed or it was edited', () => {
    const a = { name: 'a', body: '1' }
    const b = { name: 'b', body: '2' }
    const c = { name: 'c', body: '3' }
    const loc = locatorFor([a, b, c], 2)
    expect(locateExample([a, b, c], loc)).toEqual({ index: 2, changed: false })
    expect(locateExample([b, c], loc)).toEqual({ index: 1, changed: false })
    expect(locateExample([a, b, { ...c, body: 'x' }], loc)).toEqual({ index: 2, changed: true })
    expect(locateExample([a, b], loc)).toBeNull()
    const withId = locatorFor([FULL], 0)
    expect(locateExample([{ name: 'z' }, { ...FULL, name: 'moved' }], withId)).toEqual({ index: 1, changed: true })
    expect(locateExample([{ name: 'z' }], withId)).toBeNull()
  })
})

describe('creating examples', () => {
  const request = { ...newDraft({ name: 'Echo', method: 'POST', url: '{{base}}/echo?x=1' }), extras: { responses: [1], scripts: [2] } }

  it('builds one from a live text response', () => {
    const { example, note } = exampleFromResponse({
      name: '200 OK',
      request,
      response: { status: 200, statusText: 'OK', durationMs: 12.4, headers: [{ key: 'Content-Type', value: 'application/json' }], bodyText: '{"ok":true}', bodyBase64: null, bodyByteLength: 11 },
      id: 'fixed',
    })
    expect(note).toBeNull()
    expect(example).toEqual({
      id: 'fixed',
      name: '200 OK',
      originalRequest: { method: 'POST', header: [], url: { raw: '{{base}}/echo?x=1', host: ['{{base}}'], path: ['echo'], query: [{ key: 'x', value: '1' }] } },
      status: 'OK',
      code: 200,
      _postman_previewlanguage: 'json',
      header: [{ key: 'Content-Type', value: 'application/json' }],
      cookie: [],
      responseTime: 12,
      body: '{"ok":true}',
    })
    expect(Object.keys(example)).not.toContain(BODY_ENCODING_KEY)
  })

  it('stores a binary body as base64 with a marker and shows it as bytes again', () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const { example, note } = exampleFromResponse({
      name: 'img',
      request,
      response: { status: 200, statusText: '', durationMs: 1, headers: [{ key: 'Content-Type', value: 'image/png' }], bodyText: null, bodyBase64: b64, bodyByteLength: 70 },
    })
    expect(note).toMatch(/base64/)
    expect(example).toMatchObject({ body: b64, [BODY_ENCODING_KEY]: 'base64', status: 'OK', _postman_previewlanguage: 'text' })
    expect(typeof example.id).toBe('string')
    const parsed = parseExample(example, parent())
    expect(parsed.response.bodyEncoding).toBe('base64')
    const data = exampleResponseData(parsed.response)
    expect(data).toMatchObject({ bodyText: null, bodyBase64: b64, bodyByteLength: 70 })
    expect(analyzeResponse(data).kind).toBe('image')
  })

  it('keeps a note for an oversized binary body and refuses an oversized text body', () => {
    const big = 'A'.repeat(EXAMPLE_BODY_LIMIT + 4)
    const base = { status: 200, statusText: 'OK', durationMs: 1, headers: [] }
    const bin = exampleFromResponse({ name: 'n', request, response: { ...base, bodyText: null, bodyBase64: big, bodyByteLength: 9e6 } })
    expect(bin.example.body).toMatch(/^\[binary response body not stored/)
    expect(bin.example[BODY_ENCODING_KEY]).toBeUndefined()
    expect(bin.note).toMatch(/too large/)
    expect(() => exampleFromResponse({ name: 'n', request, response: { ...base, bodyText: big, bodyBase64: null, bodyByteLength: big.length } })).toThrow(/too large/)
  })

  it('makes blank examples and duplicates', () => {
    expect(blankExample('New', request, 'id1')).toMatchObject({ id: 'id1', name: 'New', code: 200, status: 'OK', body: '' })
    const dup = duplicateExample(FULL, 'Created copy', 'id2')
    expect(dup).toEqual({ ...FULL, id: 'id2', name: 'Created copy' })
    expect(dup.cookie).not.toBe(FULL.cookie)
  })

  it('maps the response half for the viewer and knows reason phrases', () => {
    const r = parseExample(FULL, parent()).response
    expect(exampleResponseData(r, 42)).toMatchObject({ status: 201, statusText: 'Created', durationMs: 42, bodyText: '{"id":7,"a":1}', bodyByteLength: 14 })
    expect(statusReason(404)).toBe('Not Found')
    expect(statusReason(299)).toBe('')
  })
})

describe('Postman round trip', () => {
  it('imports the sample collection (16 examples) and re-exports untouched examples identically', async () => {
    const text = readFileSync(SAMPLE, 'utf8')
    const original = JSON.parse(text)
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    const ws = await mock.createWorkspace('W')
    const { collection, folders, requests } = await mock.importPostmanCollection(ws.id, text)
    const total = requests.reduce((n, r) => n + exampleSummaries(r).length, 0)
    expect(total).toBe(16)
    const exported = buildPostmanCollection({ collection, folders, requests })
    const pairs = (items: any[]): [string, unknown][] => items.flatMap((i) => (i.item ? pairs(i.item) : [[i.name, i.response]]))
    const before = pairs(original.item)
    const after = pairs(exported.item)
    expect(after.map(([n]) => n)).toEqual(before.map(([n]) => n))
    for (let i = 0; i < before.length; i++) expect(JSON.stringify(after[i][1])).toBe(JSON.stringify(before[i][1]))
  })

  it('exports edited, added and removed examples of a request', async () => {
    const mock = createMockBackend({ latencyMs: 0, seed: false })
    const ws = await mock.createWorkspace('W')
    const col = await mock.createCollection(ws.id, 'C')
    const doc = JSON.stringify({ method: 'GET', url: 'https://a.example', headers: [], body: null, responses: [FULL, { name: 'gone' }] })
    let req = await mock.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: null, name: 'R', method: 'GET', url: 'https://a.example', documentJson: doc })
    const baseline = parseExample(FULL, req)
    const edited = parseExample(FULL, req)
    edited.response.name = 'Edited'
    const documentJson = updateExamples(req.documentJson, (list) => [serializeExample(list[0], baseline, edited), blankExample('Added', parseDocument(req), 'new-id')])
    req = await mock.updateRequest({ requestId: req.id, name: req.name, method: req.method, url: req.url, documentJson, expectedVersion: req.version })
    const out = buildPostmanCollection({ collection: col, folders: [], requests: [req] })
    const responses = out.item[0].response as Record<string, unknown>[]
    expect(responses.map((r) => r.name)).toEqual(['Edited', 'Added'])
    expect(responses[0]).toEqual({ ...FULL, name: 'Edited' })
  })
})
