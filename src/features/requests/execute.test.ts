/**
 * The send pipeline with scripts (runScripts is stubbed: the sandbox itself is tested in the main process).
 * Checks what the renderer does with script results: order of phases, variables reaching templates, request
 * mutations on the outgoing copy only, environment refresh, failures, and the tab's Tests/Console output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpRequestInput, McpCallInput, McpCallOutcome, McpConnectInput, RunScriptsInput, RunScriptsResult } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { settings } from '../../app/settings.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newRow } from '../../lib/kv'
import { newMcpDraft, newMcpRequestDraft, type McpDraft } from '../../lib/mcpRequest'
import { draftFingerprint, parseDocument, type RequestDraft } from '../../lib/request'
import { mcpConnections } from '../mcpRequests/connections.svelte'
import { cancelRun, executeDraft, newScriptRun, UNTRUSTED_COMMAND_MESSAGE } from './execute'
import { tabsStore } from './tabs.svelte'

let backend: ReturnType<typeof createMockBackend>
let calls: RunScriptsInput[]
let sent: HttpRequestInput[]
let respond: (input: RunScriptsInput) => Partial<RunScriptsResult>

const result = (input: RunScriptsInput, over: Partial<RunScriptsResult> = {}): RunScriptsResult => ({
  event: input.event,
  errors: [],
  request: null,
  variables: input.variables,
  collectionVariables: input.collectionVariables ?? {},
  globals: {},
  environmentChanged: false,
  console: [],
  tests: [],
  durationMs: 1,
  ...over,
})
const pre = (code: string) => [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [code] } }]
const testEv = (code: string) => [{ listen: 'test', script: { type: 'text/javascript', exec: [code] } }]

beforeEach(async () => {
  localStorage.clear()
  settings.setScriptContinueOnError(false)
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
  await app.setActiveEnvironment(app.environments.find((e) => e.name === 'Local')!.id)
  calls = []
  sent = []
  respond = () => ({})
  vi.spyOn(backend, 'runScripts').mockImplementation(async (input) => {
    calls.push(structuredClone(input))
    return result(input, respond(input))
  })
  const exec = backend.executeHttpRequest.bind(backend)
  vi.spyOn(backend, 'executeHttpRequest').mockImplementation(async (input) => {
    sent.push(structuredClone(input))
    return exec(input)
  })
})

const getUser = () => app.requests.find((r) => r.name === 'Get user')!
const withScripts = (events: unknown[]) => {
  const r = getUser()
  const draft = parseDocument(r)
  draft.extras = { ...draft.extras, scripts: events }
  return { r, draft }
}
const ctx = (r: ReturnType<typeof getUser>) => ({ workspaceId: app.workspaceId!, requestId: r.id, collectionId: r.collectionId, folderId: r.folderId })

describe('executeDraft with scripts', () => {
  it('does not call runScripts when there are no scripts', async () => {
    const r = getUser()
    const out = await executeDraft(parseDocument(r), ctx(r))
    expect(out.ok).toBe(true)
    expect(calls).toEqual([])
    expect(out.scripts.scriptCount).toBe(0)
  })

  it('runs collection -> folder -> request pre-request scripts, then the request, then tests, under one run id', async () => {
    const r = getUser()
    await backend.setCollectionScripts(r.collectionId, JSON.stringify([...pre('c()'), ...testEv('ct()')]))
    await backend.setFolderScripts(r.folderId!, JSON.stringify(pre('f()')))
    await app.reloadCollections()
    const draft = parseDocument(r)
    draft.extras = { ...draft.extras, scripts: [...pre('r()'), ...testEv('rt()')] }
    const out = await executeDraft(draft, ctx(r))
    expect(out.ok).toBe(true)
    expect(calls.map((c) => [c.event, c.scripts.map((s) => `${s.origin}:${s.code}`)])).toEqual([
      ['prerequest', ['collection:c()', 'folder:f()', 'request:r()']],
      ['test', ['collection:ct()', 'request:rt()']],
    ])
    expect(new Set(calls.map((c) => c.runId)).size).toBe(1)
    expect(sent[0].requestRunId).toBe(calls[0].runId)
    expect(sent[0].scriptSessionId).toBe(calls[0].sessionId)
    // Test scripts see the response and the sent request.
    expect(calls[1].response?.code).toBe(200)
    expect(calls[1].request.url).toMatch(/^https?:\/\//)
    expect(calls[0].request.url).toBe('{{baseUrl}}/json?userId={{userId}}&verbose=true')
  })

  it('variables set by a pre-request script resolve templates; request changes go out but are never saved', async () => {
    respond = (input) =>
      input.event === 'prerequest'
        ? {
            variables: { ...input.variables, userId: 'from-script' },
            request: { ...input.request, method: 'POST', headers: [...input.request.headers, { key: 'X-Sig', value: '{{userId}}' }] },
          }
        : {}
    const { r, draft } = withScripts(pre('x()'))
    const tab = tabsStore.openRequest(r)
    tab.draft = draft
    const fingerprint = draftFingerprint(tab.draft)
    await tabsStore.send(tab)
    expect(sent[0].url).toContain('userId=from-script')
    expect(sent[0].method).toBe('POST')
    expect(sent[0].headers).toContainEqual({ key: 'X-Sig', value: 'from-script' })
    expect(draftFingerprint(tab.draft)).toBe(fingerprint)
    expect(tab.draft.method).toBe('GET')
    expect(app.requestById(r.id)).toEqual(r)
  })

  it('a pre-request error aborts the send with a clear message unless "continue on script error" is on', async () => {
    respond = (input) => (input.event === 'prerequest' ? { errors: [{ source: 'Pre-request · request “Get user”', kind: 'error', message: 'ReferenceError: x is not defined (line 1)' }] } : {})
    const { r, draft } = withScripts(pre('x()'))
    const out = await executeDraft(draft, ctx(r))
    expect(out).toMatchObject({ ok: false, kind: 'script', error: 'Pre-request script failed (Pre-request · request “Get user”): ReferenceError: x is not defined (line 1)' })
    expect(sent).toEqual([])

    settings.setScriptContinueOnError(true)
    const again = await executeDraft(draft, ctx(r))
    expect(again.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(calls.at(-1)?.continueOnError).toBe(true)
  })

  it('reloads the environment when a script wrote to it', async () => {
    const refresh = vi.spyOn(app, 'refreshEnvVariables')
    respond = () => ({ environmentChanged: true })
    const { r, draft } = withScripts(pre('pm.environment.set("a", 1)'))
    await executeDraft(draft, ctx(r))
    expect(refresh).toHaveBeenCalled()
  })

  it('passes the collection to the scripts, reloads the scopes they wrote to; pm.variables only for one run', async () => {
    const reloadCv = vi.spyOn(app, 'reloadCollectionVariables')
    const reloadGlobals = vi.spyOn(app, 'reloadGlobals')
    respond = (input) => (input.event === 'prerequest' ? { variables: { n: 1 }, collectionVariablesChanged: true, globalsChanged: true } : {})
    const { r, draft } = withScripts(pre('x()'))
    await executeDraft(draft, ctx(r))
    await executeDraft(draft, ctx(r))
    expect(calls[0].collectionId).toBe(r.collectionId)
    expect(calls[0].globals).toBeUndefined()
    expect(calls[1].variables).toEqual({})
    expect(reloadCv).toHaveBeenCalledWith(r.collectionId)
    expect(reloadGlobals).toHaveBeenCalled()

    const run = newScriptRun()
    await executeDraft(draft, { ...ctx(r), run })
    await executeDraft(draft, { ...ctx(r), run })
    expect(calls[3].variables).toEqual({ n: 1 })
    expect(calls[3].sessionId).toBe(calls[2].sessionId)
  })

  it('a request outside a collection keeps pm.collectionVariables in memory for the run', async () => {
    respond = (input) => (input.event === 'prerequest' ? { collectionVariables: { ...input.collectionVariables, cv: 'mem' } } : {})
    const { draft } = withScripts(pre('x()'))
    draft.url = 'https://mock.slinger.local/json?cv={{cv}}'
    const run = newScriptRun()
    const out = await executeDraft(draft, { workspaceId: app.workspaceId!, requestId: null, collectionId: null, folderId: null, run })
    expect(out.ok).toBe(true)
    expect(calls[0].collectionId).toBeNull()
    expect(sent[0].url).toContain('cv=mem')
    expect(run.collectionVariables).toEqual({ cv: 'mem' })
  })

  it('resolves persisted collection variables and globals (secret globals revealed just in time)', async () => {
    const r = getUser()
    await backend.upsertCollectionVariable({ collectionId: r.collectionId, key: 'cvHost', value: 'mock.slinger.local' })
    await backend.upsertCollectionVariable({ collectionId: r.collectionId, key: 'off', value: 'x', enabled: false })
    const g = await backend.upsertGlobalVariable({ workspaceId: app.workspaceId!, key: 'gToken', value: 'sek', isSecret: true })
    await Promise.all([app.reloadCollectionVariables(r.collectionId), app.reloadGlobals()])
    const reveal = vi.spyOn(backend, 'revealGlobalVariable')
    const draft = parseDocument(r)
    draft.url = 'https://{{cvHost}}/json?t={{gToken}}'
    const out = await executeDraft(draft, ctx(r))
    expect(out.ok).toBe(true)
    expect(reveal).toHaveBeenCalledWith(g.id)
    expect(sent[0].url).toBe('https://mock.slinger.local/json?t=sek')
    expect(sent[0].historyUrl).toBe('https://mock.slinger.local/json?t={{gToken}}')

    draft.url = 'https://{{off}}/json'
    const bad = await executeDraft(draft, ctx(r))
    expect(bad).toMatchObject({ ok: false, kind: 'unresolved', unresolved: ['off'] })
    expect(bad.ok ? '' : bad.error).toMatch(/the collection ".*" or the globals/)
  })

  it('keeps test results and console output on the tab', async () => {
    respond = (input) =>
      input.event === 'test'
        ? {
            tests: [
              { name: 'ok', status: 'passed', error: null, source: 'Tests · request “Get user”' },
              { name: 'bad', status: 'failed', error: 'AssertionError: expected 200 to equal 201', source: 'Tests · request “Get user”' },
            ],
            console: [{ level: 'log', message: 'hello', timestamp: 1, source: 'Tests · request “Get user”' }],
          }
        : {}
    const { r, draft } = withScripts(testEv('pm.test()'))
    const tab = tabsStore.openRequest(r)
    tab.draft = draft
    await tabsStore.send(tab)
    expect(tab.scriptOutput?.tests.map((t) => t.status)).toEqual(['passed', 'failed'])
    expect(tab.scriptOutput?.console.map((c) => c.message)).toEqual(['hello'])
  })

  it('cancel during a pre-request script cancels the send with the same run id', async () => {
    let release!: () => void
    vi.spyOn(backend, 'runScripts').mockImplementation(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve(result(input, { errors: [{ source: 'x', kind: 'cancelled', message: 'Cancelled' }] }))
        }),
    )
    const cancel = vi.spyOn(backend, 'cancelHttpRequest')
    const { r, draft } = withScripts(pre('while (true) {}'))
    const tab = tabsStore.openRequest(r)
    tab.draft = draft
    const sending = tabsStore.send(tab)
    await vi.waitFor(() => expect(tab.runId).not.toBeNull())
    const runId = tab.runId
    await tabsStore.cancel(tab)
    release()
    const out = await sending
    expect(cancel).toHaveBeenCalledWith(runId)
    expect(out).toMatchObject({ ok: false, kind: 'cancelled' })
    expect(sent).toEqual([])
  })
})

describe('executeDraft with OAuth 2.0', () => {
  const oauthDraft = (over: Record<string, string> = {}) => {
    const r = getUser()
    const draft = parseDocument(r)
    draft.url = '{{baseUrl}}/echo'
    draft.auth.kind = 'oauth2'
    Object.assign(draft.auth.oauth2, {
      grantType: 'client_credentials',
      accessTokenUrl: '{{baseUrl}}/token',
      clientId: 'app',
      clientSecret: '{{apiToken}}',
      scope: 'read',
      password: '{{notDefinedAnywhere}}', // not used by this grant: must not block the send
      ...over,
    })
    return { r, draft }
  }

  it('asks for a token first, then sends with the stored token applied by key', async () => {
    const { r, draft } = oauthDraft()
    const refresh = vi.spyOn(backend, 'refreshOAuth2Token')
    const none = await executeDraft(draft, ctx(r))
    expect(none).toMatchObject({ ok: false, kind: 'invalid', error: expect.stringContaining('No access token yet') })
    expect(sent).toEqual([])

    const config = refresh.mock.calls[0]![0]
    expect(config).toMatchObject({ grantType: 'client_credentials', accessTokenUrl: 'https://mock.slinger.local/token', clientSecret: 'sk_live_demo_123', password: '' })
    const status = await backend.getOAuth2Token(config)

    const out = await executeDraft(draft, ctx(r))
    expect(out.ok).toBe(true)
    expect(sent[0]!.auth).toEqual({ kind: 'oauth2', oauth2: { tokenKey: status.tokenKey, addTo: 'header', headerPrefix: 'Bearer' } })
    expect(JSON.stringify(sent[0])).not.toContain(await backend.revealOAuth2Token(status.tokenKey))
    if (out.ok) expect(out.response.bodyText).toContain('Bearer mock-client_credentials-')
    expect(refresh.mock.calls.at(-1)![1]).toEqual({ ifExpiring: true })
  })

  it('refuses the implicit grant with a pointer to PKCE', async () => {
    const { r, draft } = oauthDraft({ grantType: 'implicit' })
    expect(await executeDraft(draft, ctx(r))).toMatchObject({ ok: false, kind: 'invalid', error: expect.stringContaining('Authorization Code (With PKCE)') })
  })

  it('shows a refresh failure inline', async () => {
    const { r, draft } = oauthDraft()
    backend.failNext('refreshOAuth2Token', { code: 'invalid_input', message: 'The access token expired and could not be refreshed (x). Get a new access token.' })
    expect(await executeDraft(draft, ctx(r))).toMatchObject({ ok: false, kind: 'failed', error: expect.stringContaining('Get a new access token') })
  })
})

describe('executeDraft with a pinned environment (collection runs)', () => {
  async function otherActive() {
    const other = await backend.createEnvironment(app.workspaceId!, 'Other')
    await backend.upsertEnvironmentVariable({ environmentId: other.id, key: 'baseUrl', value: 'https://other.test', isSecret: false })
    await backend.upsertEnvironmentVariable({ environmentId: other.id, key: 'userId', value: '99', isSecret: false })
    await app.reloadEnvironments()
    await app.setActiveEnvironment(other.id)
    return other
  }

  it('resolves templates and runs the scripts with the given environment, not the active one', async () => {
    const local = app.environments.find((e) => e.name === 'Local')!
    const localVars = await backend.listEnvironmentVariables(local.id)
    const localBase = localVars.find((v) => v.key === 'baseUrl')!.value!
    await otherActive()
    const { r, draft } = withScripts(pre('pm.environment.get("baseUrl")'))
    const out = await executeDraft(draft, { ...ctx(r), environment: { id: local.id, name: 'Local' } })
    expect(out.ok).toBe(true)
    expect(sent.at(-1)!.url.startsWith(localBase)).toBe(true)
    expect(calls[0]!.environmentId).toBe(local.id)
    // Without a pinned environment the active one applies.
    await executeDraft(parseDocument(r), ctx(r))
    expect(sent.at(-1)!.url.startsWith('https://other.test')).toBe(true)
  })

  it('reads the pinned environment after the pre-request scripts wrote to it', async () => {
    const local = app.environments.find((e) => e.name === 'Local')!
    await otherActive()
    const localVarId = (await backend.listEnvironmentVariables(local.id)).find((v) => v.key === 'userId')!.id
    const { r, draft } = withScripts(pre('pm.environment.set("userId", "7")'))
    // The mock does not run scripts: do the write the script would make, to the environment it was given.
    respond = (input) => {
      if (input.event === 'prerequest') {
        void backend.upsertEnvironmentVariable({
          environmentId: input.environmentId!,
          variableId: localVarId,
          key: 'userId',
          value: '7',
          isSecret: false,
        })
      }
      return {}
    }
    await executeDraft(draft, { ...ctx(r), environment: { id: local.id, name: 'Local' } })
    expect(sent.at(-1)!.url).toContain('userId=7')
  })

  it('null means no environment, even when one is active', async () => {
    await otherActive()
    const r = getUser()
    const out = await executeDraft(parseDocument(r), { ...ctx(r), environment: null })
    expect(out.ok).toBe(false)
    expect(out.ok ? [] : 'unresolved' in out ? out.unresolved : []).toEqual(expect.arrayContaining(['baseUrl']))
    expect(sent).toHaveLength(0)
  })
})

describe('executeDraft in a data-driven run', () => {
  it('passes the iteration row to the scripts and resolves {{column}} over the environment, under pm.variables', async () => {
    const r = getUser()
    const run = newScriptRun()
    run.iteration = 1
    run.iterationCount = 3
    run.iterationData = { userId: '42', baseUrl: 'https://data.test' }
    // A script variable still wins over the row.
    run.variables = { baseUrl: 'https://local.test' }
    const { draft } = withScripts(pre('pm.iterationData.get("userId")'))
    await executeDraft(draft, { ...ctx(r), run })
    expect(calls[0]!.iterationData).toEqual({ userId: '42', baseUrl: 'https://data.test' })
    expect(calls[0]!.info).toMatchObject({ iteration: 1, iterationCount: 3 })
    expect(sent.at(-1)!.url.startsWith('https://local.test/json?userId=42')).toBe(true)
  })

  it('outside data-driven runs no iterationData is sent', async () => {
    const { r, draft } = withScripts(pre('1'))
    await executeDraft(draft, ctx(r))
    expect('iterationData' in calls[0]!).toBe(false)
  })
})

describe('executeDraft with an MCP request', () => {
  let connects: McpConnectInput[]
  let mcpCalls: McpCallInput[]
  let answer: (input: McpCallInput) => Promise<McpCallOutcome>
  const okResult = { content: [{ type: 'text', text: 'Sunny' }], structuredContent: { temp: 21 } }

  beforeEach(async () => {
    await mcpConnections.reset()
    connects = []
    mcpCalls = []
    answer = async () => ({ ok: true, isError: false, result: okResult, error: null, durationMs: 7 })
    vi.spyOn(backend, 'mcpClientConnect').mockImplementation(async (input) => {
      connects.push(structuredClone(input))
      return { sessionId: `s${connects.length}`, serverInfo: { name: 'Demo', version: '1' }, protocolVersion: null, capabilities: {}, instructions: null, connectMs: 1 }
    })
    vi.spyOn(backend, 'mcpClientCall').mockImplementation(async (input) => {
      mcpCalls.push(structuredClone(input))
      return answer(input)
    })
    vi.spyOn(backend, 'mcpClientDisconnect').mockResolvedValue()
  })

  const mcpRequest = (mcp: Partial<McpDraft> = {}): RequestDraft => ({
    ...newMcpRequestDraft('Weather'),
    url: '{{baseUrl}}/mcp',
    mcp: newMcpDraft({ tool: 'get_weather', arguments: '{"city": "{{city}}", "user": {{userId}}}', ...mcp }),
  })
  const wsCtx = (over: Partial<Parameters<typeof executeDraft>[1]> = {}) => ({ workspaceId: app.workspaceId!, requestId: 'req-1', ...over })

  it('runs the scripts, connects, calls the tool and answers with a synthetic JSON response', async () => {
    respond = (input) =>
      input.event === 'prerequest'
        ? { variables: { ...input.variables, city: 'Oslo' }, request: { ...input.request, method: 'POST', url: 'http://elsewhere' } }
        : {}
    const draft = mcpRequest()
    draft.auth = { ...draft.auth, kind: 'bearer', bearer: { token: '{{apiToken}}' } }
    draft.extras = { scripts: [...pre('p()'), ...testEv('t()')] }
    const out = await executeDraft(draft, wsCtx())

    expect(sent).toEqual([])
    expect(connects).toEqual([
      {
        transport: 'http',
        url: 'https://mock.slinger.local/mcp',
        headers: [{ key: 'Authorization', value: 'Bearer sk_live_demo_123' }],
        workspaceId: app.workspaceId,
        origin: 'user',
      },
    ])
    expect(mcpCalls).toEqual([
      {
        operation: 'tools/call',
        name: 'get_weather',
        arguments: { city: 'Oslo', user: 42 },
        historyUrl: 'https://mock.slinger.local/mcp',
        historyDetail: 'tools/call get_weather',
        sessionId: 's1',
        requestRunId: calls[0].runId,
        workspaceId: app.workspaceId,
        requestId: 'req-1',
        requestName: 'Weather',
        scriptSessionId: calls[0].sessionId,
      },
    ])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.runId).toBe(calls[0].runId)
    expect(out.response).toMatchObject({
      status: 200,
      statusText: 'OK',
      durationMs: 7,
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      bodyBase64: null,
      mcp: { ok: true, isError: false, result: okResult, error: null, durationMs: 7, operation: 'tools/call', name: 'get_weather' },
    })
    expect(JSON.parse(out.response.bodyText!)).toEqual(okResult)
    expect(out.response.bodyByteLength).toBe(out.response.bodyText!.length)
    // Test scripts see the result as the response body and the request without secret values.
    expect(calls[1].event).toBe('test')
    expect(calls[1].response).toMatchObject({ code: 200, status: 'OK', body: out.response.bodyText })
    expect(calls[1].request.url).toBe('https://mock.slinger.local/mcp')
    expect(JSON.stringify(calls[1].request)).not.toContain('sk_live_demo_123')
  })

  it('reports a tool error as a 500 "Tool error" response, and a protocol error as a failed send', async () => {
    answer = async () => ({ ok: false, isError: true, result: { content: [{ type: 'text', text: 'boom' }], isError: true }, error: null, durationMs: 2 })
    const toolError = await executeDraft(mcpRequest({ tool: 'fail', arguments: '{}' }), wsCtx())
    expect(toolError).toMatchObject({ ok: true, response: { status: 500, statusText: 'Tool error', mcp: { isError: true, name: 'fail' } } })

    const error = { code: -32602, message: 'MCP error -32602: Tool nope not found', data: { hint: 'list tools' } }
    answer = async () => ({ ok: false, isError: false, result: null, error, durationMs: 2 })
    // The JSON-RPC code and data travel with the failure (the result pane shows them).
    expect(await executeDraft(mcpRequest({ tool: 'nope', arguments: '{}' }), wsCtx())).toMatchObject({
      ok: false,
      kind: 'failed',
      error: 'MCP error -32602: Tool nope not found',
      mcpError: error,
    })
  })

  it('reuses the session of a tab key, and an assistant or a run gets its own shared session', async () => {
    const draft = mcpRequest({ operation: 'resources/read', uri: 'demo://users/{{userId}}' })
    await executeDraft(draft, wsCtx({ mcpSessionKey: 'tab:1' }))
    await executeDraft(draft, wsCtx({ mcpSessionKey: 'tab:1' }))
    expect(connects).toHaveLength(1)
    expect(mcpCalls.map((c) => [c.sessionId, c.operation, c.uri])).toEqual([
      ['s1', 'resources/read', 'demo://users/42'],
      ['s1', 'resources/read', 'demo://users/42'],
    ])

    const out = await executeDraft(draft, wsCtx({ source: 'mcp' }))
    expect(connects[1].origin).toBe('mcp')
    expect(mcpCalls[2]).toMatchObject({ sessionId: 's2', historySource: 'mcp', historyDetail: 'resources/read demo://users/42' })
    expect(out.ok && out.response.mcp).toMatchObject({ operation: 'resources/read', name: 'demo://users/42' })
    await executeDraft(draft, wsCtx({ run: newScriptRun() }))
    expect(connects).toHaveLength(2)
    await executeDraft(mcpRequest({ operation: 'prompts/get', prompt: 'greet', promptArguments: [newRow({ key: 'name', value: '{{userId}}' })] }), wsCtx({ run: newScriptRun(), mcpSessionKey: 'tab:9' }))
    expect(connects[2].origin).toBe('runner')
    expect(mcpCalls.at(-1)).toMatchObject({ operation: 'prompts/get', name: 'greet', arguments: { name: '42' } })
  })

  it('reconnects once when main no longer knows the session', async () => {
    await executeDraft(mcpRequest({ arguments: '{}' }), wsCtx({ mcpSessionKey: 'tab:1' }))
    answer = async (input) => {
      if (input.sessionId === 's1') throw { name: 'IpcError', code: 'not_found', message: 'Unknown MCP session' }
      return { ok: true, isError: false, result: okResult, error: null, durationMs: 1 }
    }
    const out = await executeDraft(mcpRequest({ arguments: '{}' }), wsCtx({ mcpSessionKey: 'tab:1' }))
    expect(out.ok).toBe(true)
    expect(mcpCalls.map((c) => c.sessionId)).toEqual(['s1', 's1', 's2'])
  })

  it('an untrusted stdio command fails with a pointer to the window and the command to allow', async () => {
    vi.mocked(backend.mcpClientConnect).mockRejectedValueOnce({
      name: 'IpcError',
      code: 'invalid_input',
      message: 'This command has not been allowed on this device yet.',
      details: { reason: 'untrusted_command', command: 'node', args: ['srv.js', '42'], cwd: '', env: [{ key: 'TOKEN', value: 'sk_live_demo_123' }] },
    })
    const draft = mcpRequest({ transport: 'stdio', command: 'node', args: ['srv.js', '{{userId}}'], env: [newRow({ key: 'TOKEN', value: '{{apiToken}}' })], arguments: '{}' })
    const out = await executeDraft(draft, wsCtx({ source: 'mcp' }))
    expect(out).toMatchObject({
      ok: false,
      kind: 'failed',
      error: UNTRUSTED_COMMAND_MESSAGE,
      untrustedCommand: { command: 'node', args: ['srv.js', '42'], cwd: '', env: [{ key: 'TOKEN', value: 'sk_live_demo_123' }] },
    })
    expect(UNTRUSTED_COMMAND_MESSAGE).toContain('Open the request in Slinger and run it once')
    expect(mcpCalls).toEqual([])
    // The stdio connect input carries the resolved command and env, no url or headers.
    vi.mocked(backend.mcpClientConnect).mockClear()
    await executeDraft(draft, wsCtx())
    expect(connects.at(-1)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['srv.js', '42'],
      env: [{ key: 'TOKEN', value: 'sk_live_demo_123' }],
      cwd: '',
      workspaceId: app.workspaceId,
      origin: 'user',
    })
    expect(mcpCalls.at(-1)?.historyUrl).toBe('node srv.js 42')
  })

  it('records a secret in a resource URI as {{name}}: History detail and the result name', async () => {
    const out = await executeDraft(mcpRequest({ operation: 'resources/read', uri: 'demo://docs?key={{apiToken}}' }), wsCtx())
    expect(mcpCalls.at(-1)).toMatchObject({ uri: 'demo://docs?key=sk_live_demo_123', historyDetail: 'resources/read demo://docs?key={{apiToken}}' })
    expect(out.ok && out.response.mcp?.name).toBe('demo://docs?key={{apiToken}}')
  })

  it('stops before connecting on unresolved variables or invalid arguments', async () => {
    expect(await executeDraft(mcpRequest({ arguments: '{"a": "{{nowhere}}"}' }), wsCtx())).toMatchObject({ ok: false, kind: 'unresolved', unresolved: ['nowhere'] })
    expect(await executeDraft(mcpRequest({ arguments: '{"a": }' }), wsCtx())).toMatchObject({
      ok: false,
      kind: 'invalid',
      error: expect.stringContaining('not valid JSON'),
    })
    expect(connects).toEqual([])
  })

  it('cancel stops the MCP call with the same run id', async () => {
    let cancelled = false
    let release: () => void = () => {}
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, isError: false, result: null, error: { code: null, message: 'This operation was aborted' }, durationMs: 3 })
      })
    const mcpCancel = vi.spyOn(backend, 'mcpClientCancel')
    const httpCancel = vi.spyOn(backend, 'cancelHttpRequest')
    let runId = ''
    const pending = executeDraft(mcpRequest({ arguments: '{}' }), wsCtx({ onRunId: (id) => (runId = id), wasCancelled: () => cancelled }))
    await vi.waitFor(() => expect(mcpCalls).toHaveLength(1))
    cancelled = true
    await cancelRun(runId)
    expect(mcpCancel).toHaveBeenCalledWith(runId)
    expect(httpCancel).toHaveBeenCalledWith(runId)
    release()
    expect(await pending).toMatchObject({ ok: false, kind: 'cancelled' })
  })

  it('OAuth 2.0: the stored token is looked up, revealed for the connect and sent as a header', async () => {
    const draft = mcpRequest({ arguments: '{}' })
    draft.auth.kind = 'oauth2'
    Object.assign(draft.auth.oauth2, { grantType: 'client_credentials', accessTokenUrl: '{{baseUrl}}/token', clientId: 'app', scope: 'read' })
    const refresh = vi.spyOn(backend, 'refreshOAuth2Token')
    const none = await executeDraft(draft, wsCtx())
    // An MCP request's Authorization panel is in its Connection section (there is no Authorization tab).
    expect(none).toMatchObject({ ok: false, kind: 'invalid', error: 'No access token yet: click Get New Access Token in the Connection section.' })
    expect(connects).toEqual([])
    const status = await backend.getOAuth2Token(refresh.mock.calls[0]![0])
    const token = await backend.revealOAuth2Token(status.tokenKey)
    const out = await executeDraft(draft, wsCtx())
    expect(out.ok).toBe(true)
    expect(connects.at(-1)?.headers).toEqual([{ key: 'Authorization', value: `Bearer ${token}` }])
    expect(JSON.stringify(mcpCalls)).not.toContain(token)
  })
})
