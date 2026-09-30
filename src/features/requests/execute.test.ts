/**
 * The send pipeline with scripts (runScripts is stubbed: the sandbox itself is tested in the main process).
 * Checks what the renderer does with script results: order of phases, variables reaching templates, request
 * mutations on the outgoing copy only, environment refresh, failures, and the tab's Tests/Console output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpRequestInput, RunScriptsInput, RunScriptsResult } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { settings } from '../../app/settings.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { draftFingerprint, parseDocument } from '../../lib/request'
import { executeDraft, newScriptRun } from './execute'
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
