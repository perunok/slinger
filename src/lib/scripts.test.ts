import { describe, expect, it } from 'vitest'
import type { ApiFolder } from '../../shared/types'
import { newRow } from './kv'
import { newDraft, parseDocument, serializeDraft } from './request'
import {
  applyRequestData,
  countScripts,
  editorCode,
  folderPath,
  requestDataFromDraft,
  runnableCode,
  scopeWithScriptVariables,
  scriptChain,
  testCounts,
  withScript,
} from './scripts'
import { makeScope } from './template'

const IMPORTED = [
  { listen: 'test', script: { id: 'abc', type: 'text/javascript', exec: ['pm.test("a", () => {})', ''] } },
  { listen: 'prerequest', script: { exec: 'console.log(1)', type: 'text/javascript' }, disabled: false },
]

describe('Postman event arrays', () => {
  it('reads exec arrays and strings', () => {
    expect(editorCode(IMPORTED, 'test')).toBe('pm.test("a", () => {})\n')
    expect(editorCode(IMPORTED, 'prerequest')).toBe('console.log(1)')
    expect(editorCode(undefined, 'test')).toBe('')
  })

  it('returns the same array when nothing changed (byte-faithful save)', () => {
    expect(withScript(IMPORTED, 'test', 'pm.test("a", () => {})\n')).toBe(IMPORTED)
  })

  it('an edit replaces only exec, keeping ids and other fields and order', () => {
    const next = withScript(IMPORTED, 'test', 'x()\ny()')
    expect(next).toEqual([{ listen: 'test', script: { id: 'abc', type: 'text/javascript', exec: ['x()', 'y()'] } }, IMPORTED[1]])
    expect(next[1]).toBe(IMPORTED[1])
  })

  it('adds a Postman-shaped entry and removes one whose code is emptied', () => {
    expect(withScript([], 'prerequest', 'a()')).toEqual([{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['a()'] } }])
    expect(withScript(IMPORTED, 'prerequest', '')).toEqual([IMPORTED[0]])
  })

  it('runs every enabled entry and skips disabled or empty ones', () => {
    const events = [
      { listen: 'test', script: { exec: ['one()'] } },
      { listen: 'test', disabled: true, script: { exec: ['skipped()'] } },
      { listen: 'test', script: { exec: [''] } },
      { listen: 'test', script: { exec: ['two()'] } },
    ]
    expect(runnableCode(events, 'test')).toBe('one()\ntwo()')
    expect(countScripts(events)).toBe(2)
  })

  it('unedited scripts serialize back byte for byte, an edited one only changes its exec', () => {
    const documentJson = JSON.stringify({ name: 'R', method: 'GET', url: 'x', description: null, headers: [], body: null, auth: null, params: [], scripts: IMPORTED, responses: [], source: { event: IMPORTED } })
    const draft = parseDocument({ name: 'R', method: 'GET', url: 'x', documentJson })
    expect(JSON.stringify(JSON.parse(serializeDraft(draft).documentJson).scripts)).toBe(JSON.stringify(IMPORTED))
    draft.extras = { ...draft.extras, scripts: withScript(draft.extras.scripts, 'test', 'changed()') }
    const doc = JSON.parse(serializeDraft(draft).documentJson)
    expect(doc.scripts[0].script).toEqual({ id: 'abc', type: 'text/javascript', exec: ['changed()'] })
    expect(doc.source).toEqual({ event: IMPORTED })
  })
})

describe('script chain', () => {
  const folder = (id: string, parentFolderId: string | null, scripts: unknown[] | null): ApiFolder =>
    ({ id, workspaceId: 'w', collectionId: 'c', parentFolderId, name: id, sortOrder: 0, createdAt: 0, updatedAt: 0, version: 1, scriptsJson: scripts ? JSON.stringify(scripts) : null }) as ApiFolder
  const pre = (code: string) => [{ listen: 'prerequest', script: { exec: [code] } }]
  const folders = [folder('outer', null, pre('o()')), folder('middle', 'outer', null), folder('inner', 'middle', pre('i()')), folder('other', null, pre('x()'))]

  it('walks folders from the root down (cycle-safe)', () => {
    expect(folderPath(folders, 'inner').map((f) => f.id)).toEqual(['outer', 'middle', 'inner'])
    const cyclic = [folder('a', 'b', null), folder('b', 'a', null)]
    expect(folderPath(cyclic, 'a').map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('orders collection -> folders outer to inner -> request and skips levels without code', () => {
    const chain = scriptChain('prerequest', {
      collection: { name: 'Col', scriptsJson: JSON.stringify(pre('c()')) },
      folders,
      folderId: 'inner',
      requestName: 'Req',
      requestEvents: pre('r()'),
    })
    expect(chain).toEqual([
      { origin: 'collection', name: 'Col', code: 'c()' },
      { origin: 'folder', name: 'outer', code: 'o()' },
      { origin: 'folder', name: 'inner', code: 'i()' },
      { origin: 'request', name: 'Req', code: 'r()' },
    ])
    expect(scriptChain('test', { collection: null, folders, folderId: 'inner', requestName: 'Req', requestEvents: pre('r()') })).toEqual([])
  })
})

describe('request mutations', () => {
  it('apply to a copy only; the original draft (and so the stored request) is untouched', () => {
    const draft = newDraft({ url: '{{baseUrl}}/a', headers: [newRow({ key: 'Accept', value: 'x' }), newRow()] })
    const before = serializeDraft(draft)
    const data = requestDataFromDraft(draft)
    expect(data).toEqual({ method: 'GET', url: '{{baseUrl}}/a', headers: [{ key: 'Accept', value: 'x' }], body: { mode: 'none' } })
    const out = applyRequestData(draft, { method: 'POST', url: '{{baseUrl}}/b', headers: [{ key: 'X', value: '1' }, { key: 'Off', value: '0', disabled: true }], body: { mode: 'raw', raw: '{"a":1}', language: 'json' } })
    expect(out.method).toBe('POST')
    expect(out.url).toBe('{{baseUrl}}/b')
    expect(out.headers.filter((h) => h.key).map((h) => [h.key, h.value, h.enabled])).toEqual([
      ['X', '1', true],
      ['Off', '0', false],
    ])
    expect(out.body).toMatchObject({ kind: 'raw', raw: '{"a":1}', rawLanguage: 'json' })
    expect(serializeDraft(draft)).toEqual(before)
  })
})

describe('template scope with script variables', () => {
  it('uses Postman precedence: globals < collection < environment < local', () => {
    const env = makeScope('Env', [
      { key: 'shared', value: 'env', secret: false },
      { key: 'secret', value: null, secret: true, id: 's1' },
    ])
    const scope = scopeWithScriptVariables(env, {
      globals: { shared: 'global', g: 1 },
      collection: { shared: 'collection', c: { a: 1 } },
      local: { l: true },
    })
    expect(scope.variables.get('shared')?.value).toBe('env')
    expect(scope.variables.get('g')?.value).toBe('1')
    expect(scope.variables.get('c')?.value).toBe('{"a":1}')
    expect(scope.variables.get('l')?.value).toBe('true')
    expect(scope.variables.get('secret')).toMatchObject({ secret: true, id: 's1' })
    const local = scopeWithScriptVariables(env, { globals: {}, collection: {}, local: { shared: 'local', secret: 'shadow' } })
    expect(local.variables.get('shared')?.value).toBe('local')
    expect(local.variables.get('secret')).toMatchObject({ secret: false, value: 'shadow' })
  })
})

describe('testCounts', () => {
  it('counts statuses and treats a crashed test script as a failure', () => {
    const t = (status: 'passed' | 'failed' | 'skipped') => ({ name: 'x', status, error: null, source: 'Tests · request “R”' })
    expect(testCounts({ tests: [t('passed'), t('failed'), t('skipped')], errors: [{ source: 'Tests · request “R”', kind: 'error', message: 'boom' }, { source: 'Pre-request · request “R”', kind: 'error', message: 'x' }] })).toEqual({
      passed: 1,
      failed: 2,
      skipped: 1,
      total: 4,
    })
    expect(testCounts(null)).toEqual({ passed: 0, failed: 0, skipped: 0, total: 0 })
  })
})
