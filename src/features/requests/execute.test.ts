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
import { sessionVars } from '../scripts/sessionVars'
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
  collectionVariables: input.collectionVariables,
  globals: input.globals,
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
  sessionVars.reset()
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

  it('collection variables and globals persist for the session; pm.variables only for one run', async () => {
    respond = (input) => (input.event === 'prerequest' ? { variables: { n: 1 }, collectionVariables: { cv: 'x' }, globals: { g: true } } : {})
    const { r, draft } = withScripts(pre('x()'))
    await executeDraft(draft, ctx(r))
    await executeDraft(draft, ctx(r))
    expect(calls[1].variables).toEqual({})
    expect(calls[1].collectionVariables).toEqual({ cv: 'x' })
    expect(calls[1].globals).toEqual({ g: true })

    const run = newScriptRun()
    await executeDraft(draft, { ...ctx(r), run })
    await executeDraft(draft, { ...ctx(r), run })
    expect(calls[3].variables).toEqual({ n: 1 })
    expect(calls[3].sessionId).toBe(calls[2].sessionId)
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
