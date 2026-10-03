import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunScriptsInput } from '../../../shared/types'
import { WORKFLOW_INPUT_KEY, WORKFLOW_OUTPUT_KEY } from '../../../shared/workflowScript'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { NODE_DEFS, type NodeConfigs, type NodeType, type WorkflowGraph, type WorkflowNode } from '../../lib/workflow/graph'
import { tabsStore } from '../requests/tabs.svelte'
import { workflowRuns } from './workflowRuns.svelte'
import WorkflowsPanel from './WorkflowsPanel.svelte'

let mock: ReturnType<typeof createMockBackend>
let requestId: string

beforeEach(async () => {
  localStorage.clear()
  toast.items = []
  mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  await app.init()
  tabsStore.tabs = []
  tabsStore.activeId = null
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'API')
  const req = await mock.createRequest({
    workspaceId: ws,
    collectionId: col.id,
    name: 'User',
    method: 'GET',
    url: 'https://mock.slinger.local/json?id={{id}}',
    documentJson: JSON.stringify({ method: 'GET', url: 'https://mock.slinger.local/json?id={{id}}' }),
  })
  requestId = req.id
  await app.reloadCollections()
})
afterEach(cleanup)

let n = 0
const node = <T extends NodeType>(type: T, config: Partial<NodeConfigs[T]> = {}): WorkflowNode<T> => ({
  id: `${type}-${++n}`,
  type,
  position: { x: n * 10, y: 0 },
  config: { ...NODE_DEFS[type].defaults(), ...config },
})
const edge = (a: WorkflowNode, port: string, b: WorkflowNode) => ({ id: `e${++n}`, source: a.id, sourcePort: port, target: b.id })

/** The browser mock does not execute scripts: answer like the sandbox would, with a JS function per code text. */
function fakeSandbox(impl: (input: unknown) => unknown) {
  return vi.spyOn(mock, 'runScripts').mockImplementation(async (job: RunScriptsInput) => ({
    event: job.event,
    errors: [],
    request: null,
    variables: { ...job.variables, [WORKFLOW_OUTPUT_KEY]: impl(job.iterationData?.[WORKFLOW_INPUT_KEY]) },
    collectionVariables: {},
    globals: {},
    environmentChanged: false,
    console: [{ level: 'log', message: 'hello from the sandbox', timestamp: 0, source: 'x' }],
    tests: [],
    durationMs: 1,
  }))
}

async function finished(workflowId: string) {
  await waitFor(() => expect(workflowRuns.forWorkflow(workflowId)?.running).toBe(false))
  return workflowRuns.forWorkflow(workflowId)!
}

describe('workflow runs (real send pipeline, mock backend)', () => {
  it('sends the saved request with the input as {{variables}}, and shows every step', async () => {
    const start = node('start', { value: '{"id": 42}' })
    const send = node('request', { requestId })
    const shape = node('evaluate', { code: 'return input.status' })
    const out = node('output', { label: 'Status' })
    const graph: WorkflowGraph = { v: 1, nodes: [start, send, shape, out], edges: [edge(start, 'out', send), edge(send, 'response', shape), edge(shape, 'out', out)] }
    const sandbox = fakeSandbox((input) => (input as { status: number }).status)
    const exec = vi.spyOn(mock, 'executeHttpRequest')

    const session = await finished(workflowRuns.start('wf1', graph).workflowId)

    expect(session.summary).toMatchObject({ phase: 'done', steps: 4 })
    expect(exec.mock.calls[0]![0].url).toBe('https://mock.slinger.local/json?id=42')
    // Evaluate got the response as its input (through the iteration data) and its code wrapped for the sandbox.
    const job = sandbox.mock.calls[0]![0]
    expect(job.iterationData?.[WORKFLOW_INPUT_KEY]).toMatchObject({ status: 200 })
    expect(job.scripts[0]!.code).toContain('return input.status')
    expect(session.node(out.id)).toMatchObject({ status: 'done', input: 200 })
    expect(session.node(send.id).output).toMatchObject({ status: 200, body: expect.anything() })
    expect(session.log.map((l) => l.kind)).toContain('console')
    expect(session.log.at(-2)!.text).toBe('Status: 200')
    // The output key never leaks into the run's pm.variables.
    expect(Object.keys(sandbox.mock.calls[0]![0].variables)).not.toContain(WORKFLOW_OUTPUT_KEY)
  })

  it('stops a run, and a workspace switch stops the runs of the workspace left', async () => {
    const start = node('start')
    const wait = node('delay', { ms: 60_000 })
    const graph: WorkflowGraph = { v: 1, nodes: [start, wait], edges: [edge(start, 'out', wait)] }
    workflowRuns.start('wf2', graph)
    await waitFor(() => expect(workflowRuns.forWorkflow('wf2')!.node(wait.id).status).toBe('running'))
    workflowRuns.stop('wf2')
    expect((await finished('wf2')).summary?.phase).toBe('stopped')

    workflowRuns.start('wf3', graph)
    const other = await mock.createWorkspace('Other')
    await app.selectWorkspace(other.id)
    expect(workflowRuns.forWorkflow('wf3')).toBeNull()
  })

  it('a deleted request fails its node with a clear message', async () => {
    const start = node('start')
    const send = node('request', { requestId: '00000000-0000-4000-8000-000000000000' })
    const session = await finished(workflowRuns.start('wf4', { v: 1, nodes: [start, send], edges: [edge(start, 'out', send)] }).workflowId)
    expect(session.summary?.error?.message).toBe('Send request: its request was deleted')
    expect(session.node(send.id)).toMatchObject({ status: 'error', error: 'its request was deleted' })
  })
})

describe('Workflows sidebar panel', () => {
  it('creates a workflow (with a Start node) and opens it in a tab; renames; deletes and closes the tab', async () => {
    render(WorkflowsPanel)
    await fireEvent.click(screen.getAllByRole('button', { name: 'New workflow' })[0]!)
    const dialog = screen.getByRole('dialog')
    await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: 'Checkout' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(app.workflows.map((w) => w.name)).toEqual(['Checkout']))
    const id = app.workflows[0]!.id
    expect(tabsStore.active?.workflowId).toBe(id)
    expect(tabsStore.active?.title).toBe('Checkout')
    expect(JSON.parse((await mock.getWorkflow(id)).graphJson).nodes.map((x: { type: string }) => x.type)).toEqual(['start'])

    await fireEvent.contextMenu(screen.getByRole('button', { name: 'Checkout' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const rename = screen.getByRole('dialog')
    await fireEvent.input(within(rename).getByRole('textbox'), { target: { value: 'Checkout flow' } })
    await fireEvent.click(within(rename).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(tabsStore.active?.title).toBe('Checkout flow'))

    await fireEvent.contextMenu(screen.getByRole('button', { name: 'Checkout flow' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(app.workflows).toEqual([]))
    expect(tabsStore.tabs).toEqual([])
    await expect(mock.getWorkflow(id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('filters, and duplicates', async () => {
    const ws = app.workspaceId!
    for (const name of ['Alpha', 'Beta']) await mock.createWorkflow({ workspaceId: ws, name })
    await app.reloadWorkflows()
    render(WorkflowsPanel)
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter workflows' }), { target: { value: 'alp' } })
    expect(within(screen.getByRole('list', { name: 'Workflow list' })).getAllByRole('button', { name: /^(Alpha|Beta)$/ }).map((b) => b.textContent?.trim())).toEqual(['Alpha'])
    await fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    await waitFor(() => expect(app.workflows.map((w) => w.name)).toEqual(['Alpha', 'Alpha copy', 'Beta']))
  })
})
