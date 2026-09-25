/**
 * Component tests: Tests and Console views, the response viewer's Tests/Console tabs, the request Scripts panel
 * (editing, byte-faithful drafts, read-only gating) and the collection/folder Scripts dialog.
 */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpResponseData, ScriptConsoleEntry, ScriptTestResult } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { draftFingerprint } from '../../lib/request'
import type { ScriptOutput } from '../../lib/scripts'
import ResponseViewer from '../response/ResponseViewer.svelte'
import ScriptsPanel from '../requests/ScriptsPanel.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import { sync } from '../sync/syncStore.svelte'
import ConsoleView from './ConsoleView.svelte'
import ScriptsDialog from './ScriptsDialog.svelte'
import TestsView from './TestsView.svelte'

afterEach(cleanup)

const test = (name: string, status: ScriptTestResult['status'], error: string | null = null): ScriptTestResult => ({ name, status, error, source: 'Tests · request “R”' })
const log = (level: ScriptConsoleEntry['level'], message: string): ScriptConsoleEntry => ({ level, message, timestamp: Date.UTC(2026, 0, 1, 10, 0, 0), source: 'Pre-request · request “R”' })
const output = (over: Partial<ScriptOutput> = {}): ScriptOutput => ({ tests: [], console: [], errors: [], scriptCount: 1, ...over })

describe('TestsView', () => {
  it('lists results with counts and filters by status', async () => {
    render(TestsView, { output: output({ tests: [test('status is 200', 'passed'), test('has id', 'failed', 'AssertionError: expected {} to have property \'id\''), test('later', 'skipped')] }) })
    expect(screen.getByTestId('tests-summary')).toHaveTextContent('1 passed, 1 failed, 1 skipped')
    const list = screen.getByRole('list', { name: 'Test results' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(list).toHaveTextContent("AssertionError: expected {} to have property 'id'")
    await fireEvent.click(screen.getByLabelText('Failed'))
    expect(within(list).getAllByRole('listitem').map((li) => li.dataset.status)).toEqual(['failed'])
  })

  it('shows script errors as failures and explains an empty result', () => {
    render(TestsView, { output: output({ errors: [{ source: 'Tests · request “R”', kind: 'timeout', message: 'Script timed out after 5000 ms' }] }) })
    expect(screen.getByTestId('tests-summary')).toHaveTextContent('0 passed, 1 failed')
    expect(screen.getByText('Script error (timed out)')).toBeInTheDocument()
    cleanup()
    render(TestsView, { output: output() })
    expect(screen.getByText(/recorded no tests/)).toBeInTheDocument()
  })
})

describe('ConsoleView', () => {
  it('shows levels, timestamps and messages, filters by level and clears', async () => {
    const onclear = vi.fn()
    render(ConsoleView, { entries: [log('log', 'token = abc'), log('warn', 'careful'), log('error', 'Error: boom')], onclear })
    const list = screen.getByRole('list', { name: 'Console output' })
    expect(within(list).getAllByRole('listitem').map((li) => li.dataset.level)).toEqual(['log', 'warn', 'error'])
    expect(list).toHaveTextContent('token = abc')
    expect(list.textContent).toMatch(/\d\d:\d\d:\d\d\.\d{3}/)
    await fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'error' } })
    expect(within(screen.getByRole('list', { name: 'Console output' })).getAllByRole('listitem')).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Clear console' }))
    expect(onclear).toHaveBeenCalled()
  })
})

describe('ResponseViewer with script results', () => {
  const data: HttpResponseData = { status: 200, statusText: 'OK', durationMs: 5, headers: [], bodyText: '{}', bodyBase64: null, bodyByteLength: 2 }

  it('adds Tests (pass/total badge, red when something failed) and Console tabs', async () => {
    const onviewchange = vi.fn()
    render(ResponseViewer, { data, scripts: output({ tests: [test('a', 'passed'), test('b', 'failed', 'x')], console: [log('log', 'hi')] }), onviewchange })
    expect(screen.getByTestId('resp-tests-badge')).toHaveTextContent('1/2')
    expect(screen.getByTestId('resp-tests-badge').className).toMatch(/text-danger/)
    expect(screen.getByTestId('resp-console-badge')).toHaveTextContent('1')
    await fireEvent.click(screen.getByRole('tab', { name: /^Tests/ }))
    expect(onviewchange).toHaveBeenCalledWith('tests')
  })

  it('renders the Tests panel and falls back to the body when there are no script results', () => {
    render(ResponseViewer, { data, scripts: output({ tests: [test('a', 'passed')] }), view: 'tests' })
    expect(screen.getByTestId('tests-view')).toBeInTheDocument()
    expect(screen.getByTestId('resp-tests-badge').className).toMatch(/text-success/)
    cleanup()
    render(ResponseViewer, { data, scripts: null, view: 'tests' })
    expect(screen.queryByRole('tab', { name: /^Tests/ })).toBeNull()
    expect(screen.queryByTestId('tests-view')).toBeNull()
  })
})

const viewOf = (label: string) => EditorView.findFromDOM(screen.getByRole('textbox', { name: label }).closest('.cm-editor') as HTMLElement)!
const type = (label: string, text: string) => {
  const v = viewOf(label)
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}

describe('request Scripts panel', () => {
  let backend: ReturnType<typeof createMockBackend>
  beforeEach(async () => {
    localStorage.clear()
    backend = createMockBackend({ latencyMs: 0 })
    window.slinger = backend
    window.__slingerMock = backend
    tabsStore.tabs = []
    await app.init()
  })

  it('edits pre-request and test scripts into the draft in Postman event shape; clearing restores the saved draft', async () => {
    const tab = tabsStore.openRequest(app.requests.find((r) => r.name === 'Get user')!)
    const saved = draftFingerprint(tab.draft)
    render(ScriptsPanel, { tab })
    type('Pre-request script', "pm.variables.set('a', 1)")
    expect(tab.draft.extras.scripts).toEqual([{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["pm.variables.set('a', 1)"] } }])
    expect(tab.dirty).toBe(true)
    await fireEvent.click(screen.getByRole('tab', { name: /^Tests/ }))
    type('Test script', "pm.test('ok', () => {})\npm.test('b', () => {})")
    expect(tab.draft.extras.scripts).toHaveLength(2)
    expect((tab.draft.extras.scripts as Array<{ script: { exec: string[] } }>)[1].script.exec).toEqual(["pm.test('ok', () => {})", "pm.test('b', () => {})"])
    type('Test script', '')
    await fireEvent.click(screen.getByRole('tab', { name: /^Pre-request/ }))
    type('Pre-request script', '')
    expect(draftFingerprint(tab.draft)).toBe(saved)
    expect(tab.dirty).toBe(false)
  })

  it('offers pm autocompletion', async () => {
    const { pmCompletionSource } = await import('../../components/editor/cm/pmCompletion')
    const { EditorState } = await import('@codemirror/state')
    const { CompletionContext } = await import('@codemirror/autocomplete')
    const at = (doc: string) => pmCompletionSource(new CompletionContext(EditorState.create({ doc }), doc.length, false))
    expect(at('pm.env')?.options.map((o) => o.label)).toContain('environment')
    expect(at('pm.environment.')?.options.map((o) => o.label)).toEqual(expect.arrayContaining(['get', 'set', 'unset', 'has', 'toObject']))
    expect(at('pm.response.')?.options.map((o) => o.label)).toEqual(expect.arrayContaining(['code', 'json', 'headers', 'to']))
    expect(at('stat')?.options.map((o) => o.label)).toContain('status')
  })

  it('is read-only in a read-only (viewer) workspace', async () => {
    const blocked = vi.spyOn(sync, 'blocked', 'get').mockReturnValue(true)
    const tab = tabsStore.openRequest(app.requests.find((r) => r.name === 'Get user')!)
    render(ScriptsPanel, { tab })
    expect(viewOf('Pre-request script').state.readOnly).toBe(true)
    expect(screen.getByTestId('readonly-note')).toBeInTheDocument()
    blocked.mockRestore()
  })
})

describe('collection / folder Scripts dialog', () => {
  let backend: ReturnType<typeof createMockBackend>
  beforeEach(async () => {
    localStorage.clear()
    backend = createMockBackend({ latencyMs: 0 })
    window.slinger = backend
    await app.init()
  })

  it('saves collection scripts in Postman shape and keeps Save disabled until something changed', async () => {
    const col = app.collections[0]
    const onclose = vi.fn()
    render(ScriptsDialog, { props: { target: { kind: 'collection', id: col.id }, onclose } })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    type('Pre-request script', "pm.request.headers.upsert({ key: 'X-Col', value: '1' })")
    await waitFor(() => expect(save).not.toBeDisabled())
    await fireEvent.click(save)
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const stored = (await backend.listCollections(app.workspaceId!)).find((c) => c.id === col.id)!
    expect(JSON.parse(stored.scriptsJson!)).toEqual([{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["pm.request.headers.upsert({ key: 'X-Col', value: '1' })"] } }])
    expect(app.collections.find((c) => c.id === col.id)?.scriptsJson).toBe(stored.scriptsJson)
  })

  it('edits folder scripts and keeps unknown event fields', async () => {
    const folder = app.folders[0]
    await backend.setFolderScripts(folder.id, JSON.stringify([{ listen: 'test', script: { id: 'keep', type: 'text/javascript', exec: ['a()'] } }]))
    await app.reloadCollection(folder.collectionId)
    render(ScriptsDialog, { props: { target: { kind: 'folder', id: folder.id }, onclose: () => {} } })
    await fireEvent.click(screen.getByRole('tab', { name: /^Tests/ }))
    expect(viewOf('Test script').state.doc.toString()).toBe('a()')
    type('Test script', 'b()')
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => {
      const f = (await backend.listFolders(folder.collectionId)).find((x) => x.id === folder.id)!
      expect(JSON.parse(f.scriptsJson!)).toEqual([{ listen: 'test', script: { id: 'keep', type: 'text/javascript', exec: ['b()'] } }])
    })
  })

  it('opens from the collection context menu state and is read-only for viewers', async () => {
    const blocked = vi.spyOn(sync, 'blocked', 'get').mockReturnValue(true)
    render(ScriptsDialog, { props: { target: { kind: 'collection', id: app.collections[0].id }, onclose: () => {} } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(viewOf('Pre-request script').state.readOnly).toBe(true)
    blocked.mockRestore()
    expect(ui.scriptsFor).toBeNull()
  })
})
