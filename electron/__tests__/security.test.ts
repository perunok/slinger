/**
 * Local security state (migration 0019) and secret hygiene of the HTTP path: script trust per collection, the AI
 * assistant's unreviewed changes, scripts without secret access, redaction for assistants, and error messages that
 * never carry resolved values into history.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunScriptsInput } from '../../shared/types'
import { buildRequest } from '../services/httpExecutor'
import { baseHttp, DOC, makeEnv, scaffold, startTestServer, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
let collectionId: string
let envId: string
const SECRET = 'sk-live-0a1b2c3d4e5f'

beforeEach(async () => {
  env = makeEnv()
  const s = await scaffold(env)
  wsId = s.workspace.id
  collectionId = s.collection.id
  envId = (await env.api.createEnvironment(wsId, 'Staging')).id
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'apiKey', value: SECRET, isSecret: true })
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'baseUrl', value: 'http://localhost', isSecret: false })
})
afterEach(() => env.cleanup())

let seq = 0
const scripts = (code: string, over: Partial<RunScriptsInput> = {}): RunScriptsInput => ({
  runId: `run-${++seq}`,
  sessionId: `session-${seq}`,
  workspaceId: wsId,
  environmentId: envId,
  event: 'prerequest',
  scripts: [{ origin: 'collection', name: 'C', code }],
  request: { method: 'GET', url: 'http://x', headers: [], body: { mode: 'none' } },
  response: null,
  variables: {},
  info: { requestName: 'R', requestId: null, iteration: 0, iterationCount: 1 },
  collectionId,
  ...over,
})

const POSTMAN = JSON.stringify({
  info: { name: 'Imported', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: [{ listen: 'prerequest', script: { exec: ["pm.environment.set('ran', 'yes')"] } }],
  item: [{ name: 'Get', request: { method: 'GET', url: 'http://example.com/a' } }],
})

describe('script trust', () => {
  it('runs the scripts of a collection made here, and refuses an imported one until the user allows it', async () => {
    expect((await env.api.runScripts(scripts('1'))).errors).toEqual([])
    const imported = await env.api.importPostmanCollection(wsId, POSTMAN)
    const id = imported.collection.id
    await expect(env.api.runScripts(scripts('1', { collectionId: id }))).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'untrusted_scripts', collectionId: id, collectionName: 'Imported' },
    })
    // An empty chain needs no permission; a request outside any collection neither.
    await expect(env.api.runScripts(scripts('1', { collectionId: id, scripts: [] }))).resolves.toBeTruthy()
    await expect(env.api.runScripts(scripts('1', { collectionId: null }))).resolves.toBeTruthy()

    await env.api.trustCollectionScripts(id)
    expect((await env.api.runScripts(scripts("pm.environment.set('ran', 'yes')", { collectionId: id }))).errors).toEqual([])
  })

  it('a collection extracted from (or restored as a copy of) an untrusted one stays untrusted', async () => {
    const imported = await env.api.importPostmanCollection(wsId, POSTMAN)
    const folder = await env.api.createFolder({ workspaceId: wsId, collectionId: imported.collection.id, parentFolderId: null, name: 'F' })
    const extracted = await env.api.extractFolderToCollection({ folderId: folder.id, name: 'X', copyCollectionVariables: false })
    await expect(env.api.runScripts(scripts('1', { collectionId: extracted.collection.id }))).rejects.toMatchObject({ details: { reason: 'untrusted_scripts' } })
    const mine = await env.api.createFolder({ workspaceId: wsId, collectionId, parentFolderId: null, name: 'Mine' })
    const fromMine = await env.api.extractFolderToCollection({ folderId: mine.id, name: 'Y', copyCollectionVariables: false })
    expect((await env.api.runScripts(scripts('1', { collectionId: fromMine.collection.id }))).errors).toEqual([])
  })
})

describe('scripts without secret access (denySecrets)', () => {
  it('a secret read throws the given message inside the script; plain variables still read', async () => {
    const r = await env.api.runScripts(
      scripts("pm.variables.set('u', pm.environment.get('baseUrl')); console.log(pm.environment.get('apiKey'))", {
        denySecrets: 'not available here.',
      }),
    )
    expect(r.variables.u).toBe('http://localhost')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.message).toContain('Secret variable "apiKey": not available here.')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('also through replaceIn and pm.variables', async () => {
    const r = await env.api.runScripts(scripts("console.log(pm.variables.replaceIn('{{apiKey}}'))", { denySecrets: 'no.' }))
    expect(r.errors).toHaveLength(1)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('redactSecrets replaces the secrets a session’s scripts read', async () => {
    const input = scripts("pm.environment.get('apiKey')")
    await env.api.runScripts(input)
    const [out] = await env.api.redactSecrets({ scriptSessionId: input.sessionId, oauth2TokenKey: null, texts: [`key=${SECRET}`] })
    expect(out).toBe('key={{apiKey}}')
  })
})

describe('assistant changes', () => {
  const create = () => env.api.createRequest({ workspaceId: wsId, collectionId, folderId: null, name: 'R', method: 'GET', url: 'http://a', documentJson: DOC })

  it('a request counts while its content is what the assistant wrote; a user edit or clear ends it', async () => {
    const r = await create()
    await env.api.markAssistantChange({ kind: 'request', requestId: r.id, created: true })
    expect(await env.api.listAssistantChanges(wsId)).toEqual({ requests: [{ requestId: r.id, created: true }], variables: [], containers: [] })
    // Renames and saved examples change nothing that is sent.
    const renamed = await env.api.renameRequest(r.id, 'Renamed')
    const withExample = await env.api.updateRequest({
      requestId: r.id,
      name: renamed.name,
      method: 'GET',
      url: 'http://a',
      documentJson: JSON.stringify({ ...JSON.parse(DOC), responses: [{ name: 'ex' }] }),
      expectedVersion: renamed.version,
    })
    expect((await env.api.listAssistantChanges(wsId)).requests).toHaveLength(1)
    await env.api.updateRequest({ requestId: r.id, name: 'Renamed', method: 'GET', url: 'http://b', documentJson: withExample.documentJson, expectedVersion: withExample.version })
    expect((await env.api.listAssistantChanges(wsId)).requests).toEqual([])

    await env.api.markAssistantChange({ kind: 'request', requestId: r.id })
    expect((await env.api.listAssistantChanges(wsId)).requests).toEqual([{ requestId: r.id, created: false }])
    await env.api.clearAssistantChange({ kind: 'request', requestId: r.id })
    expect((await env.api.listAssistantChanges(wsId)).requests).toEqual([])
  })

  it('a pending record counts whatever the content is, until the record after the write', async () => {
    const r = await create()
    await env.api.markAssistantChange({ kind: 'request', requestId: r.id, pending: true })
    await env.api.updateRequest({ requestId: r.id, name: 'R', method: 'POST', url: 'http://c', documentJson: DOC, expectedVersion: r.version })
    expect((await env.api.listAssistantChanges(wsId)).requests).toHaveLength(1)
    await env.api.markAssistantChange({ kind: 'variable', environmentId: envId, key: 'newVar', pending: true })
    await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'newVar', value: 'x', isSecret: false })
    expect((await env.api.listAssistantChanges(wsId)).variables).toEqual([{ environmentId: envId, key: 'newVar' }])
  })

  it('a collection / folder auth counts until it changes or the user saves it (migration 0020)', async () => {
    const bearer = JSON.stringify({ type: 'bearer', bearer: [{ key: 'token', value: 't', type: 'string' }] })
    await env.api.setCollectionAuth(collectionId, bearer)
    const folder = await env.api.createFolder({ workspaceId: wsId, collectionId, name: 'F' })
    await env.api.setFolderAuth(folder.id, '{"type":"noauth"}')
    await env.api.markAssistantChange({ kind: 'container', containerKind: 'collection', id: collectionId })
    await env.api.markAssistantChange({ kind: 'container', containerKind: 'folder', id: folder.id })
    expect((await env.api.listAssistantChanges(wsId)).containers).toEqual(
      expect.arrayContaining([{ kind: 'collection', id: collectionId }, { kind: 'folder', id: folder.id }]),
    )
    await env.api.setCollectionAuth(collectionId, JSON.stringify({ type: 'bearer', bearer: [{ key: 'token', value: 'user', type: 'string' }] }))
    expect((await env.api.listAssistantChanges(wsId)).containers).toEqual([{ kind: 'folder', id: folder.id }])
    await env.api.clearAssistantChange({ kind: 'container', containerKind: 'folder', id: folder.id })
    expect((await env.api.listAssistantChanges(wsId)).containers).toEqual([])
    await expect(env.api.markAssistantChange({ kind: 'container', containerKind: 'folder', id: collectionId })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a variable counts until its value changes', async () => {
    await env.api.markAssistantChange({ kind: 'variable', environmentId: envId, key: 'baseUrl' })
    expect((await env.api.listAssistantChanges(wsId)).variables).toEqual([{ environmentId: envId, key: 'baseUrl' }])
    const v = (await env.api.listEnvironmentVariables(envId)).find((x) => x.key === 'baseUrl')!
    await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'baseUrl', value: 'http://other', isSecret: false, variableId: v.id })
    expect((await env.api.listAssistantChanges(wsId)).variables).toEqual([])
    await expect(env.api.markAssistantChange({ kind: 'variable', environmentId: envId, key: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('HTTP errors never carry resolved values into history', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>
  beforeAll(async () => {
    server = await startTestServer()
  })
  afterAll(() => server.close())

  const historyText = async () => JSON.stringify(await env.api.listHistory(wsId))

  it('an invalid header value is named, not quoted (validation, and the executor behind it)', async () => {
    const err = await env.api
      .executeHttpRequest(baseHttp(wsId, { url: `${server.baseUrl}/x`, historyUrl: `${server.baseUrl}/x`, headers: [{ key: 'X-Key', value: `${SECRET}\u0001` }] }))
      .then(() => ({ message: 'no error' }), (e: unknown) => e as { message: string })
    expect(err.message).toContain('X-Key')
    expect(err.message).not.toContain(SECRET)
    const direct = await buildRequest(baseHttp(wsId, { url: `${server.baseUrl}/x`, headers: [{ key: 'X-Key', value: `a${SECRET}\u0000b` }] })).then(() => ({ message: 'no error' }), (e: unknown) => e as { message: string })
    expect(direct.message).toBe('Invalid header "X-Key": its value contains characters that are not allowed in HTTP headers')
    expect(await historyText()).not.toContain(SECRET)
  })

  it('invalid credentials are not quoted', async () => {
    for (const auth of [
      { kind: 'bearer' as const, bearer: { token: `a${SECRET}\u0000b` } },
      { kind: 'apiKey' as const, apiKey: { key: 'X-Api-Key', value: `a${SECRET}\u0000b`, addTo: 'header' as const } },
    ]) {
      const err = await buildRequest(baseHttp(wsId, { url: `${server.baseUrl}/x`, auth })).then(() => ({ message: 'no error' }), (e: unknown) => e as { message: string })
      expect(err.message).toMatch(/^Invalid auth/)
      expect(err.message).not.toContain(SECRET)
    }
  })

  it('an invalid URL is shown in its safe form (secrets as {{name}})', async () => {
    const err = await env.api
      .executeHttpRequest(baseHttp(wsId, { url: `http://[${SECRET}/x`, historyUrl: 'http://[{{apiKey}}/x' }))
      .then(() => ({ message: 'no error' }), (e: unknown) => e as { message: string })
    expect(err.message).toBe('"http://[{{apiKey}}/x" is not a valid URL')
    expect(await historyText()).not.toContain(SECRET)
  })

  it('platform errors that quote the URL or a host from a secret are scrubbed', async () => {
    const withCreds = server.baseUrl.replace('http://', `http://user:${SECRET}@`)
    const err = await env.api
      .executeHttpRequest(baseHttp(wsId, { url: `${withCreds}/x`, historyUrl: server.baseUrl.replace('http://', 'http://user:{{apiKey}}@') + '/x' }))
      .then(() => ({ message: 'no error' }), (e: unknown) => e as { message: string })
    expect(err.message).not.toBe('no error')
    expect(err.message).not.toContain(SECRET)
    const host = `${SECRET.toLowerCase()}.invalid`
    const dns = await env.api
      .executeHttpRequest(baseHttp(wsId, { url: `http://${host}/x`, historyUrl: 'http://{{apiKey}}.invalid/x', timeoutMs: 5000 }))
      .then(() => ({ message: 'no error' }), (e: unknown) => e as { message: string })
    expect(dns.message).not.toBe('no error')
    expect(dns.message).not.toContain(SECRET.toLowerCase())
    expect(await historyText()).not.toContain(SECRET)
    expect((await historyText()).toLowerCase()).not.toContain(SECRET.toLowerCase())
  })
})
