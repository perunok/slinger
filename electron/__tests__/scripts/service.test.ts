/**
 * runScripts through the IPC API (validation boundary + ScriptService + repositories): environment persistence,
 * the secret policy, read-only workspaces, history redaction, request mutations, collection/folder script
 * storage, versions and the Postman round trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunScriptsInput, ScriptSource } from '../../../shared/types'
import { buildPostmanCollection } from '../../../src/lib/postman'
import { toErrorPayload } from '../../lib/errors'
import type { ScriptExecutor } from '../../scripts/executor'
import { ScriptService } from '../../services/scriptService'
import { insertLink } from '../../sync/linking'
import { baseHttp, DOC, makeEnv, scaffold, startTestServer, type TestEnv } from '../helpers'

let env: TestEnv
let wsId: string
let collectionId: string
let envId: string
const SECRET = 'sk-live-9f8e7d6c5b4a'

beforeEach(async () => {
  env = makeEnv()
  const s = await scaffold(env)
  wsId = s.workspace.id
  collectionId = s.collection.id
  envId = (await env.api.createEnvironment(wsId, 'Staging')).id
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'baseUrl', value: 'http://localhost', isSecret: false })
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'apiKey', value: SECRET, isSecret: true })
})
afterEach(() => env.cleanup())

let seq = 0
function input(code: string | ScriptSource[], over: Partial<RunScriptsInput> = {}): RunScriptsInput {
  seq++
  return {
    runId: `run-${seq}`,
    sessionId: 'session-1',
    workspaceId: wsId,
    environmentId: envId,
    event: 'prerequest',
    scripts: typeof code === 'string' ? [{ origin: 'request', name: 'Login', code }] : code,
    request: { method: 'GET', url: '{{baseUrl}}/login', headers: [], body: { mode: 'none' } },
    response: null,
    variables: {},
    collectionVariables: {},
    globals: {},
    info: { requestName: 'Login', requestId: null, iteration: 0, iterationCount: 1 },
    ...over,
  }
}

const vars = async () => Object.fromEntries((await env.api.listEnvironmentVariables(envId)).map((v) => [v.key, v]))

/** Every text cell of every table: nothing a script touched may store a secret in plain text. */
function databaseText(): string {
  const tables = (env.core.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name)
  return tables.map((t) => JSON.stringify(env.core.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
}

describe('runScripts: environment writes', () => {
  it('persists set/unset to the active environment (typed values as text, "" clears)', async () => {
    const r = await env.api.runScripts(
      input(`
        pm.environment.set('token', 'abc')
        pm.environment.set('count', 3)
        pm.environment.set('obj', { a: 1 })
        pm.environment.set('baseUrl', '')
        pm.environment.set('tmp', 'x'); pm.environment.unset('tmp')
      `),
    )
    expect(r.errors).toEqual([])
    expect(r.environmentChanged).toBe(true)
    const v = await vars()
    expect(v.token.value).toBe('abc')
    expect(v.count.value).toBe('3')
    expect(v.obj.value).toBe('{"a":1}')
    expect(v.baseUrl.value).toBe('')
    expect(v.tmp).toBeUndefined()
  })

  it('without an active environment, writes last for the run only and a warning says so', async () => {
    const r = await env.api.runScripts(input(`pm.environment.set('x', '1'); pm.test('same run', () => pm.expect(pm.environment.get('x')).to.equal('1'))`, { environmentId: null }))
    expect(r.environmentChanged).toBe(false)
    expect(r.tests[0].status).toBe('passed')
    expect(r.console[0]).toMatchObject({ level: 'warn', message: expect.stringMatching(/No environment is active/) })
  })

  it('refuses an environment of another workspace and bad run ids', async () => {
    const other = await env.api.createWorkspace('Other')
    const e = await env.api.createEnvironment(other.id, 'E')
    await expect(env.api.runScripts(input('1', { environmentId: e.id }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.runScripts(input('1', { runId: 'bad id!' }))).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('runScripts: secret policy', () => {
  it('a secret is readable only by explicit name, and set() keeps it secret (keychain, not SQLite)', async () => {
    const r = await env.api.runScripts(
      input(`
        const all = pm.environment.toObject()
        pm.test('not in toObject', () => pm.expect(all).to.not.have.property('apiKey'))
        pm.test('explicit get', () => pm.expect(pm.environment.get('apiKey')).to.equal('${SECRET}'))
        pm.environment.set('apiKey', 'rotated-${SECRET}')
      `),
    )
    expect(r.tests.map((t) => t.status)).toEqual(['passed', 'passed'])
    const v = await vars()
    expect(v.apiKey).toMatchObject({ isSecret: true, value: null })
    expect(await env.api.revealEnvironmentVariable(v.apiKey.id)).toBe(`rotated-${SECRET}`)
    expect(databaseText()).not.toContain(SECRET)
  })

  it('a script that never asks for a secret never receives it (the keychain is not read)', async () => {
    const get = vi.spyOn(env.secrets, 'get')
    await env.api.runScripts(input(`pm.environment.get('baseUrl'); pm.variables.replaceIn('{{baseUrl}}'); pm.environment.toObject()`))
    expect(get).not.toHaveBeenCalled()
  })

  it('secrets never reach history, the database or main-process logs; console output only travels in the result', async () => {
    const server = await startTestServer()
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')]
    try {
      const pre = await env.api.runScripts(
        input(`
          const key = pm.environment.get('apiKey')
          console.log('key is', key)
          pm.request.url.query.add({ key: 'k', value: key })
        `, { request: { method: 'GET', url: `${server.baseUrl}/echo`, headers: [], body: { mode: 'none' } } }),
      )
      expect(pre.console[0].message).toBe(`key is ${SECRET}`) // shown to the user who asked for it
      // The renderer sends what the script produced; its history URL is the same text (no {{ }} left to keep).
      await env.api.executeHttpRequest(baseHttp(wsId, { url: pre.request!.url, historyUrl: pre.request!.url, scriptSessionId: 'session-1' }))
      expect(server.last().url).toContain(SECRET) // the request itself did carry it
      const [entry] = await env.api.listHistory(wsId)
      expect(entry.url).toBe(`${server.baseUrl}/echo?k={{apiKey}}`)
      expect(databaseText()).not.toContain(SECRET)
      for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
    } finally {
      logs.forEach((s) => s.mockRestore())
      await server.close()
    }
  })

  it('a different session is not redacted (redaction is scoped to the scripts that read the secret)', async () => {
    const server = await startTestServer()
    try {
      await env.api.runScripts(input(`pm.environment.get('apiKey')`))
      await env.api.executeHttpRequest(baseHttp(wsId, { url: `${server.baseUrl}/x`, historyUrl: `${server.baseUrl}/plain`, scriptSessionId: 'other-session' }))
      expect((await env.api.listHistory(wsId))[0].url).toBe(`${server.baseUrl}/plain`)
    } finally {
      await server.close()
    }
  })
})

describe('runScripts: read-only (viewer) workspaces', () => {
  let folderId: string
  beforeEach(async () => {
    folderId = (await env.api.createFolder({ workspaceId: wsId, collectionId, name: 'F' })).id
    insertLink(env.core.db, {
      workspaceId: wsId, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'viewer',
      clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
    })
  })

  it('pm.environment.set fails the script clearly and nothing is written', async () => {
    const before = await vars()
    const r = await env.api.runScripts(input(`pm.environment.set('token', 'x')`))
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toMatch(/read-only .*viewer/)
    expect(r.environmentChanged).toBe(false)
    expect(await vars()).toEqual(before)
  })

  it('reads and run-local scopes still work', async () => {
    const r = await env.api.runScripts(input(`pm.variables.set('a', pm.environment.get('baseUrl')); pm.collectionVariables.set('b', 1)`))
    expect(r.errors).toEqual([])
    expect(r.variables).toEqual({ a: 'http://localhost' })
    expect(r.collectionVariables).toEqual({ b: 1 })
  })

  it('collection and folder scripts cannot be edited', async () => {
    for (const write of [env.api.setCollectionScripts(collectionId, '[]'), env.api.setFolderScripts(folderId, '[]')]) {
      const err = await write.catch((e: unknown) => e)
      expect(toErrorPayload(err).code).toBe('read_only')
    }
  })
})

describe('runScripts: request mutations', () => {
  it('returns the mutated request but never changes the stored request', async () => {
    const created = await env.api.createRequest({ workspaceId: wsId, collectionId, name: 'Login', method: 'GET', url: '{{baseUrl}}/login', documentJson: DOC })
    const r = await env.api.runScripts(input(`pm.request.headers.add({ key: 'X-Sig', value: 'abc' }); pm.request.method = 'POST'`, { info: { requestName: 'Login', requestId: created.id, iteration: 0, iterationCount: 1 } }))
    expect(r.request).toMatchObject({ method: 'POST', headers: [{ key: 'X-Sig', value: 'abc' }] })
    const [stored] = await env.api.listRequests(collectionId)
    expect(stored).toEqual(created)
  })

  it('test scripts cannot mutate the request', async () => {
    const r = await env.api.runScripts(input(`pm.request.method = 'DELETE'`, { event: 'test', response: { code: 200, status: 'OK', headers: [], body: '', responseTime: 1, size: 0 } }))
    expect(r.request).toBeNull()
  })
})

describe('cancelHttpRequest cancels a script run', () => {
  it('aborts the run with the same id', async () => {
    let seen: AbortSignal | null = null
    const fake: ScriptExecutor = {
      run: (job, io) =>
        new Promise((resolve) => {
          seen = io.signal
          io.signal.addEventListener('abort', () =>
            resolve({ errors: [{ source: 'x', kind: 'cancelled', message: 'Cancelled' }], request: null, variables: {}, collectionVariables: {}, globals: {}, envOps: [], console: [], tests: [], durationMs: 1 }),
          )
          void job
        }),
      dispose: async () => {},
    }
    env.core.scripts = new ScriptService(env.core.db, env.core.environments, fake)
    const pending = env.api.runScripts(input('while (true) {}', { runId: 'cancel-me' }))
    await new Promise((r) => setTimeout(r, 10))
    await env.api.cancelHttpRequest('cancel-me')
    const r = await pending
    expect(seen!.aborted).toBe(true)
    expect(r.errors[0].kind).toBe('cancelled')
  })
})

describe('collection and folder scripts', () => {
  const EVENTS = [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: ["pm.variables.set('from', 'collection')"] } },
    { listen: 'test', script: { id: 'keep-me', type: 'text/javascript', exec: ['pm.test("ok", () => {})', ''] } },
  ]

  it('are stored verbatim, cleared with null or [], and validated', async () => {
    const json = JSON.stringify(EVENTS)
    expect((await env.api.setCollectionScripts(collectionId, json)).scriptsJson).toBe(json)
    expect((await env.api.listCollections(wsId))[0].scriptsJson).toBe(json)
    const folder = await env.api.createFolder({ workspaceId: wsId, collectionId, name: 'F' })
    expect(folder.scriptsJson).toBeNull()
    expect((await env.api.setFolderScripts(folder.id, json)).scriptsJson).toBe(json)
    expect((await env.api.setFolderScripts(folder.id, '[]')).scriptsJson).toBeNull()
    expect((await env.api.setCollectionScripts(collectionId, null)).scriptsJson).toBeNull()
    await expect(env.api.setCollectionScripts(collectionId, '{"not":"an array"}')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.setFolderScripts(folder.id, 'not json')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('are captured by versions and come back on restore (copy and replace)', async () => {
    const json = JSON.stringify(EVENTS)
    await env.api.setCollectionScripts(collectionId, json)
    const folder = await env.api.createFolder({ workspaceId: wsId, collectionId, name: 'F' })
    await env.api.setFolderScripts(folder.id, json)
    const version = await env.api.createCollectionVersion({ collectionId, version: '1.0.0' })
    const detail = await env.api.getCollectionVersion(version.id)
    expect(detail.snapshot.collectionScriptsJson).toBe(json)
    expect(detail.snapshot.folders[0].scriptsJson).toBe(json)

    const copy = await env.api.restoreCollectionVersion(version.id, 'copy')
    expect(copy.scriptsJson).toBe(json)
    expect((await env.api.listFolders(copy.id))[0].scriptsJson).toBe(json)

    await env.api.setCollectionScripts(collectionId, null)
    await env.api.setFolderScripts(folder.id, null)
    const replaced = await env.api.restoreCollectionVersion(version.id, 'replace')
    expect(replaced.scriptsJson).toBe(json)
    expect((await env.api.listFolders(collectionId))[0].scriptsJson).toBe(json)
  })

  it('a version without scripts keeps the pre-0005 snapshot shape', async () => {
    const version = await env.api.createCollectionVersion({ collectionId, version: '1.0.0' })
    const raw = (env.core.db.prepare('SELECT snapshot_json FROM collection_versions WHERE id = ?').get(version.id) as { snapshot_json: string }).snapshot_json
    expect(Object.keys(JSON.parse(raw))).toEqual(['collectionName', 'folders', 'requests'])
  })
})

describe('Postman round trip with collection, folder and request events', () => {
  const collection = {
    info: { name: 'Scripted', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Auth',
        item: [
          {
            name: 'Login',
            event: [
              { listen: 'test', script: { id: 'a1', exec: ['const t = pm.response.json().token;', "pm.environment.set('token', t);"], type: 'text/javascript' } },
              { listen: 'prerequest', script: { exec: [''], type: 'text/javascript' } },
            ],
            request: { method: 'POST', header: [], url: { raw: '{{baseUrl}}/login', host: ['{{baseUrl}}'], path: ['login'] } },
            response: [],
          },
        ],
        event: [{ listen: 'prerequest', script: { exec: ["console.log('folder')"], type: 'text/javascript' } }],
      },
      { name: 'Ping', request: { method: 'GET', header: [], url: { raw: 'https://x.test/ping', protocol: 'https', host: ['x', 'test'], path: ['ping'] } } },
    ],
    event: [
      { listen: 'prerequest', script: { type: 'text/javascript', exec: ["pm.request.headers.upsert({key: 'X-Col', value: '1'})"] } },
      { listen: 'test', script: { type: 'text/javascript', exec: ["pm.test('2xx', () => pm.response.to.be.success)"] } },
    ],
  }

  it('imports scripts at every level, counts them and exports every event byte for byte', async () => {
    const imported = await env.api.importPostmanCollection(wsId, JSON.stringify(collection))
    // 2 collection + 1 folder + 1 request (the empty pre-request entry is kept but not counted)
    expect(imported.scriptCount).toBe(4)
    expect(imported.collection.scriptsJson).toBe(JSON.stringify(collection.event))
    expect(imported.folders[0].scriptsJson).toBe(JSON.stringify(collection.item[0].event))
    expect(JSON.parse(imported.requests.find((r) => r.name === 'Login')!.documentJson).scripts).toEqual(collection.item[0].item![0].event)

    const exported = buildPostmanCollection({
      collection: (await env.api.listCollections(wsId)).find((c) => c.id === imported.collection.id)!,
      folders: await env.api.listFolders(imported.collection.id),
      requests: await env.api.listRequests(imported.collection.id),
    })
    expect(JSON.stringify(exported.event)).toBe(JSON.stringify(collection.event))
    expect(JSON.stringify(exported.item[0].event)).toBe(JSON.stringify(collection.item[0].event))
    expect(JSON.stringify(exported.item[0].item![0].event)).toBe(JSON.stringify(collection.item[0].item![0].event))
    expect(exported.item[1].event).toBeUndefined()
  })
})
