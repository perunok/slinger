/**
 * runScripts with persisted collection variables and globals: loading, precedence, persistence of set/unset/clear
 * (coalesced), secret globals (explicit-name reads, history redaction), read-only workspaces and sync isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunScriptsInput } from '../../../shared/types'
import { insertLink } from '../../sync/linking'
import { coalesceEnvOps } from '../../services/scriptService'
import { baseHttp, makeEnv, scaffold, startTestServer, type TestEnv } from '../helpers'

let env: TestEnv
let wsId: string
let collectionId: string
const SECRET = 'glob-secret-4f3e2d1c'

beforeEach(async () => {
  env = makeEnv()
  const s = await scaffold(env)
  wsId = s.workspace.id
  collectionId = s.collection.id
})
afterEach(() => env.cleanup())

let seq = 0
function input(code: string, over: Partial<RunScriptsInput> = {}): RunScriptsInput {
  seq++
  return {
    runId: `pv-${seq}`,
    sessionId: 'session-pv',
    workspaceId: wsId,
    environmentId: null,
    collectionId,
    event: 'prerequest',
    scripts: [{ origin: 'request', name: 'R', code }],
    request: { method: 'GET', url: 'http://x', headers: [], body: { mode: 'none' } },
    response: null,
    variables: {},
    info: { requestName: 'R', requestId: null, iteration: 0, iterationCount: 1 },
    ...over,
  }
}
const cvs = async () => Object.fromEntries((await env.api.listCollectionVariables(collectionId)).map((v) => [v.key, v]))
const gvs = async () => Object.fromEntries((await env.api.listGlobalVariables(wsId)).map((v) => [v.key, v]))

describe('coalesceEnvOps', () => {
  it('keeps the last write per key and drops everything before a clear', () => {
    expect(coalesceEnvOps([{ op: 'set', key: 'a', value: '1' }, { op: 'set', key: 'b', value: '2' }, { op: 'set', key: 'a', value: '3' }])).toEqual([
      { op: 'set', key: 'b', value: '2' },
      { op: 'set', key: 'a', value: '3' },
    ])
    expect(coalesceEnvOps([{ op: 'set', key: 'a', value: '1' }, { op: 'clear' }, { op: 'unset', key: 'b' }])).toEqual([{ op: 'clear' }, { op: 'unset', key: 'b' }])
  })
})

describe('runScripts: persisted collection variables and globals', () => {
  it('scripts see stored enabled values with Postman precedence', async () => {
    await env.api.upsertCollectionVariable({ collectionId, key: 'shared', value: 'from-collection' })
    await env.api.upsertCollectionVariable({ collectionId, key: 'off', value: 'hidden', enabled: false })
    await env.api.upsertGlobalVariable({ workspaceId: wsId, key: 'shared', value: 'from-globals', isSecret: false })
    await env.api.upsertGlobalVariable({ workspaceId: wsId, key: 'g', value: 'global', isSecret: false })
    const r = await env.api.runScripts(
      input(`
        pm.test('collection beats globals', () => pm.expect(pm.variables.get('shared')).to.equal('from-collection'))
        pm.test('globals fall back', () => pm.expect(pm.variables.get('g')).to.equal('global'))
        pm.test('disabled is invisible', () => pm.expect(pm.collectionVariables.has('off')).to.be.false)
        pm.test('replaceIn', () => pm.expect(pm.variables.replaceIn('{{shared}}/{{g}}')).to.equal('from-collection/global'))
      `),
    )
    expect(r.errors).toEqual([])
    expect(r.tests.map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed'])
    expect(r.collectionVariablesChanged).toBe(false)
    expect(r.globalsChanged).toBe(false)
  })

  it('persists set / unset / clear (typed values as text), coalesced, and reports what changed', async () => {
    await env.api.upsertCollectionVariable({ collectionId, key: 'old', value: '1' })
    await env.api.upsertCollectionVariable({ collectionId, key: 'off', value: 'x', enabled: false })
    await env.api.upsertGlobalVariable({ workspaceId: wsId, key: 'gone', value: 'x', isSecret: false })
    const r = await env.api.runScripts(
      input(`
        pm.collectionVariables.set('token', 'a'); pm.collectionVariables.set('token', 'b')
        pm.collectionVariables.set('n', 3)
        pm.collectionVariables.unset('old')
        pm.collectionVariables.set('off', 'on now')
        pm.globals.set('obj', { a: 1 })
        pm.globals.unset('gone')
        pm.test('same-run read keeps the JSON value', () => pm.expect(pm.globals.get('obj')).to.eql({ a: 1 }))
      `),
    )
    expect(r.errors).toEqual([])
    expect(r.collectionVariablesChanged).toBe(true)
    expect(r.globalsChanged).toBe(true)
    const c = await cvs()
    expect(Object.keys(c).sort()).toEqual(['n', 'off', 'token'])
    expect([c.token.value, c.token.version, c.n.value, c.off.value, c.off.enabled]).toEqual(['b', 1, '3', 'on now', true])
    const g = await gvs()
    expect(Object.keys(g)).toEqual(['obj'])
    expect(g.obj.value).toBe('{"a":1}')

    const cleared = await env.api.runScripts(input(`pm.collectionVariables.clear(); pm.collectionVariables.set('after', '1')`))
    expect(cleared.errors).toEqual([])
    expect(Object.keys(await cvs())).toEqual(['after'])
  })

  it('a request outside a collection gets an in-memory collection scope and a warning', async () => {
    const r = await env.api.runScripts(input(`pm.collectionVariables.set('a', 1)`, { collectionId: null, collectionVariables: { seed: 'x' } }))
    expect(r.errors).toEqual([])
    expect(r.collectionVariables).toEqual({ seed: 'x', a: 1 })
    expect(r.collectionVariablesChanged).toBe(false)
    expect(r.console.some((l) => l.level === 'warn' && /not saved in a collection/.test(l.message))).toBe(true)
  })

  it('refuses a collection of another workspace', async () => {
    const other = await env.api.createWorkspace('Other')
    const col = await env.api.createCollection(other.id, 'X')
    await expect(env.api.runScripts(input('1', { collectionId: col.id }))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('secret globals: read by explicit name only, set keeps them secret, and history redacts what scripts read', async () => {
    const g = await env.api.upsertGlobalVariable({ workspaceId: wsId, key: 'apiKey', value: SECRET, isSecret: true })
    const get = vi.spyOn(env.secrets, 'get')
    const quiet = await env.api.runScripts(input(`pm.globals.toObject(); pm.variables.toObject(); pm.globals.has('apiKey')`))
    expect(quiet.errors).toEqual([])
    expect(get).not.toHaveBeenCalled()
    expect(quiet.globals).toEqual({})

    const server = await startTestServer()
    try {
      const pre = await env.api.runScripts(
        input(`
          pm.request.url.query.add({ key: 'k', value: pm.globals.get('apiKey') })
          pm.test('replaceIn resolves it too', () => pm.expect(pm.variables.replaceIn('{{apiKey}}')).to.equal('${SECRET}'))
        `, { request: { method: 'GET', url: `${server.baseUrl}/echo`, headers: [], body: { mode: 'none' } } }),
      )
      expect(pre.errors).toEqual([])
      expect(pre.globals).toEqual({}) // secret values never travel back in the scope record
      await env.api.executeHttpRequest(baseHttp(wsId, { url: pre.request!.url, historyUrl: pre.request!.url, scriptSessionId: 'session-pv' }))
      expect(server.last().url).toContain(SECRET)
      expect((await env.api.listHistory(wsId))[0]!.url).toBe(`${server.baseUrl}/echo?k={{apiKey}}`)
    } finally {
      await server.close()
    }

    const set = await env.api.runScripts(input(`pm.globals.set('apiKey', 'rotated-value-123')`))
    expect(set.errors).toEqual([])
    const stored = (await gvs()).apiKey
    expect(stored).toMatchObject({ isSecret: true, value: null })
    expect(await env.api.revealGlobalVariable(g.id)).toBe('rotated-value-123')
    const empty = await env.api.runScripts(input(`pm.globals.set('apiKey', '')`))
    expect(empty.errors[0]?.message).toMatch(/secret/)
  })

  it('read-only workspaces: writes fail the script, reads work, nothing is stored', async () => {
    await env.api.upsertCollectionVariable({ collectionId, key: 'c', value: '1' })
    await env.api.upsertGlobalVariable({ workspaceId: wsId, key: 'g', value: '2', isSecret: false })
    insertLink(env.core.db, {
      workspaceId: wsId, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'viewer',
      clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
    })
    const reads = await env.api.runScripts(input(`pm.test('r', () => pm.expect(pm.variables.get('c') + pm.globals.get('g')).to.equal('12'))`))
    expect(reads.errors).toEqual([])
    expect(reads.tests[0]!.status).toBe('passed')
    for (const code of [`pm.collectionVariables.set('c', 'x')`, `pm.globals.unset('g')`, `pm.globals.clear()`]) {
      const r = await env.api.runScripts(input(code))
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]!.message).toMatch(/read-only .*viewer/)
    }
    expect((await cvs()).c.value).toBe('1')
    expect((await gvs()).g.value).toBe('2')
  })

  it('script writes to a linked workspace mark the variables dirty for sync (synced since 0009)', async () => {
    insertLink(env.core.db, {
      workspaceId: wsId, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'editor',
      clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
    })
    env.core.db.prepare('DELETE FROM sync_dirty').run()
    const r = await env.api.runScripts(input(`pm.collectionVariables.set('a', '1'); pm.globals.set('b', '2')`))
    expect(r.errors).toEqual([])
    const types = (env.core.db.prepare('SELECT DISTINCT entity_type AS t FROM sync_dirty ORDER BY t').all() as Array<{ t: string }>).map((x) => x.t)
    expect(types).toEqual(['collection_variable', 'global_variable'])
  })
})
