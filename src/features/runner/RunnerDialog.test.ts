import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import RunnerDialog from './RunnerDialog.svelte'
import { runsStore } from './runs.svelte'

const H = 'https://mock.slinger.local'
const doc = (name: string, method: string, url: string) => JSON.stringify({ name, method, url, headers: [], body: null, auth: null })

async function setup(requests: Array<[string, string]>) {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  window.__slingerMock = mock
  await app.init()
  const ws = app.workspaceId!
  const col = await mock.createCollection(ws, 'Runner col')
  for (const [name, url] of requests) {
    await mock.createRequest({ workspaceId: ws, collectionId: col.id, name, method: 'GET', url, documentJson: doc(name, 'GET', url) })
  }
  await app.reloadCollections()
  ui.runner = { collectionId: col.id, folderId: null }
  render(RunnerDialog)
  return Object.assign(mock, { target: { collectionId: col.id, folderId: null } })
}

beforeEach(() => {
  ui.runner = null
  for (const s of runsStore.sessions) runsStore.dismiss(s)
  toast.items = []
})

const execCount = (mock: { calls: Array<{ method: string }> }) => mock.calls.filter((c) => c.method === 'executeHttpRequest').length
const progress = () => runsStore.attention.map((r) => [r.label, r.running, r.state.completed, r.state.rows.length])

describe('RunnerDialog', () => {
  it('lists requests, runs them in order and summarises', async () => {
    const mock = await setup([['A ok', `${H}/json`], ['B missing', `${H}/404`], ['C vars', '{{nope}}/x']])
    const list = screen.getByRole('list', { name: 'Requests to run' })
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3)
    const tick = app.historyTick
    await fireEvent.click(screen.getByRole('button', { name: 'Run 3 requests' }))
    const summary = await screen.findByTestId('summary', {}, { timeout: 3000 })
    expect(summary).toHaveTextContent('1 passed')
    expect(summary).toHaveTextContent('2 failed')
    const rows = within(screen.getByRole('list', { name: 'Run results' })).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['passed', 'failed', 'failed'])
    expect(rows[1]).toHaveTextContent('404')
    expect(rows[2]).toHaveTextContent('{{nope}}')
    const sent = mock.calls.filter((c) => c.method === 'executeHttpRequest')
    expect(sent).toHaveLength(2) // unresolved variables never reach the network
    expect(app.historyTick).toBeGreaterThanOrEqual(tick + 3)
    // expandable details
    await fireEvent.click(within(rows[0]).getByRole('button', { name: /Show details/ }))
    expect(within(rows[0]).getByText('Response headers')).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('Slinger mock')
  })

  it('fails a 3xx by default and passes it with "Treat 3xx as pass"', async () => {
    await setup([['Redirect', `${H}/302`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request' }))
    let summary = await screen.findByTestId('summary', {}, { timeout: 3000 })
    expect(summary).toHaveTextContent('1 failed')
    const row = within(screen.getByRole('list', { name: 'Run results' })).getAllByRole('listitem')[0]
    expect(row).toHaveAttribute('data-status', 'failed')
    expect(row).toHaveTextContent('302')
    expect(row).toHaveTextContent('HTTP 302')
    await fireEvent.click(screen.getByRole('button', { name: 'Configure' }))
    const box = screen.getByRole('checkbox', { name: 'Treat 3xx as pass' })
    expect(box).not.toBeChecked()
    await fireEvent.click(box)
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request' }))
    summary = await screen.findByTestId('summary', {}, { timeout: 3000 })
    expect(summary).toHaveTextContent('1 passed')
  })

  it('respects the selection', async () => {
    const mock = await setup([['A', `${H}/json`], ['B', `${H}/text`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: /^Run 0 requests/ })).toBeDisabled()
    await fireEvent.click(within(screen.getByRole('list', { name: 'Requests to run' })).getAllByRole('checkbox')[1])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request' }))
    await screen.findByTestId('summary')
    expect(mock.calls.filter((c) => c.method === 'executeHttpRequest')).toHaveLength(1)
  })

  it('Stop aborts the in-flight request and skips the rest', async () => {
    const mock = await setup([['Slow', `${H}/slow`], ['Fast', `${H}/json`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 2 requests' }))
    await waitFor(() => expect(mock.calls.some((c) => c.method === 'executeHttpRequest')).toBe(true))
    // The status bar reads the progress of the run from the runs store.
    expect(progress()).toEqual([['Runner col', true, 0, 2]])
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    const summary = await screen.findByTestId('summary', {}, { timeout: 2000 })
    expect(summary).toHaveTextContent('(stopped)')
    // Stopped while its dialog is open: nothing left for the status bar and no notification.
    expect(progress()).toEqual([])
    expect(toast.items).toHaveLength(0)
    expect(summary).toHaveTextContent('2 skipped')
    expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(1)
    expect(mock.calls.filter((c) => c.method === 'executeHttpRequest')).toHaveLength(1)
  })

  it('closing while running sends the run to the background; reopening shows its live progress', async () => {
    const mock = await setup([['Slow', `${H}/slow`], ['Fast', `${H}/json`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 2 requests' }))
    await waitFor(() => expect(execCount(mock)).toBe(1))
    await fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(ui.runner).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toast.items.map((t) => t.title)).toEqual(['The run continues in the background'])
    expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(0)
    expect(progress()).toEqual([['Runner col', true, 0, 2]])
    // Back to it (the status bar does this): same run, still going.
    ui.runner = { ...mock.target }
    expect(await screen.findByTestId('progress')).toHaveTextContent('/2')
    expect(screen.getByRole('button', { name: 'Run in background' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByTestId('summary', {}, { timeout: 2000 })
    expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(1)
  })

  it('"Run in background" from the options starts the run and closes the dialog', async () => {
    const mock = await setup([['A', `${H}/json`], ['B', `${H}/text`]])
    await fireEvent.input(screen.getByLabelText('Delay between requests (ms)'), { target: { value: '150' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }))
    expect(ui.runner).toBeNull()
    // It runs with the dialog closed: first one done, the second waits for the delay.
    await waitFor(() => expect(progress()).toEqual([['Runner col', true, 1, 2]]))
    expect(execCount(mock)).toBe(1)
  })

  it('a run finished in the background notifies with its result, stays in the status bar until opened, then goes on close', async () => {
    const mock = await setup([['A ok', `${H}/json`], ['B missing', `${H}/404`]])
    await fireEvent.input(screen.getByLabelText('Delay between requests (ms)'), { target: { value: '100' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }))
    await waitFor(() => expect(toast.items.some((t) => t.title === 'Run finished: Runner col')).toBe(true), { timeout: 3000 })
    const done = toast.items.find((t) => t.title === 'Run finished: Runner col')!
    expect(done.kind).toBe('error')
    expect(done.detail).toBe('1 passed, 1 failed')
    expect(progress()).toEqual([['Runner col', false, 2, 2]])
    expect(execCount(mock)).toBe(2)
    // "View results" opens the finished run.
    done.action!.run()
    expect(ui.runner).toEqual(mock.target)
    expect(await screen.findByTestId('summary')).toHaveTextContent('1 passed')
    expect(progress()).toEqual([])
    // Closing a finished run drops it, as before.
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(runsStore.sessions).toHaveLength(0)
  })

  it('a reopened run keeps its options for Configure and Run again', async () => {
    const mock = await setup([['A', `${H}/json`], ['B', `${H}/text`], ['C', `${H}/json`]])
    await fireEvent.click(within(screen.getByRole('list', { name: 'Requests to run' })).getAllByRole('checkbox')[1]!)
    await fireEvent.input(screen.getByLabelText('Delay between requests (ms)'), { target: { value: '120' } })
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Stop on first failure' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }))
    ui.runner = { ...mock.target }
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Configure' }))
    expect(screen.getByLabelText('Delay between requests (ms)')).toHaveValue(120)
    expect(screen.getByRole('checkbox', { name: 'Stop on first failure' })).toBeChecked()
    expect(within(screen.getByRole('list', { name: 'Requests to run' })).getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([true, false, true])
  })

  it('the run keeps the environment it started with', async () => {
    const mock = await setup([['A', '{{base}}/json'], ['B', '{{base}}/text']])
    const ws = app.workspaceId!
    const first = await mock.createEnvironment(ws, 'First')
    const second = await mock.createEnvironment(ws, 'Second')
    await mock.upsertEnvironmentVariable({ environmentId: first.id, key: 'base', value: H, isSecret: false })
    await mock.upsertEnvironmentVariable({ environmentId: second.id, key: 'base', value: 'https://second.invalid', isSecret: false })
    await app.reloadEnvironments()
    await app.setActiveEnvironment(first.id)
    await fireEvent.input(screen.getByLabelText('Delay between requests (ms)'), { target: { value: '150' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Run 2 requests' }))
    expect(await screen.findByTestId('run-environment')).toHaveTextContent('Environment: First')
    await waitFor(() => expect(execCount(mock)).toBe(1))
    await app.setActiveEnvironment(second.id)
    const summary = await screen.findByTestId('summary', {}, { timeout: 3000 })
    expect(summary).toHaveTextContent('2 passed')
    const urls = mock.calls.filter((c) => c.method === 'executeHttpRequest').map((c) => (c.args[0] as { url: string }).url)
    expect(urls).toEqual([`${H}/json`, `${H}/text`])
  })

  it('data-driven: a CSV gives one iteration per row, {{column}} per iteration, results grouped by iteration', async () => {
    const mock = await setup([['Create', `${H}/json?c={{customerName}}`]])
    const csv = new File(['customerName,plan\nAcme,pro\nGlobex,free\n'], 'customers.csv', { type: 'text/csv' })
    await fireEvent.change(screen.getByLabelText('Data file'), { target: { files: [csv] } })
    expect(await screen.findByTestId('data-summary')).toHaveTextContent('2 rows · 2 columns')
    expect(screen.getByLabelText('Iterations')).toHaveValue(2)
    const preview = screen.getByRole('table', { name: 'Data preview' })
    expect(preview).toHaveTextContent('customerName')
    expect(preview).toHaveTextContent('Globex')
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request × 2' }))
    const summary = await screen.findByTestId('summary', {}, { timeout: 3000 })
    expect(summary).toHaveTextContent('2 passed')
    expect(summary).toHaveTextContent('2 iterations')
    expect(screen.getByTestId('run-environment')).toHaveTextContent('Data: customers.csv')
    const urls = mock.calls.filter((c) => c.method === 'executeHttpRequest').map((c) => (c.args[0] as { url: string }).url)
    expect(urls).toEqual([`${H}/json?c=Acme`, `${H}/json?c=Globex`])
    const iterations = within(screen.getByRole('list', { name: 'Iterations' })).getAllByRole('button')
    expect(iterations.map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Iteration 1 customerName: Acme 1 passed', 'Iteration 2 customerName: Globex 1 passed'])
    await fireEvent.click(iterations[1]!)
    expect(within(screen.getByRole('list', { name: 'Results of iteration 2' })).getByText('Create')).toBeInTheDocument()
  })

  it('checks the iteration count and reports a bad data file', async () => {
    await setup([['A', `${H}/json`]])
    await fireEvent.input(screen.getByLabelText('Iterations'), { target: { value: '0' } })
    expect(screen.getByText(/Iterations must be a whole number from 1 to 10000/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Run 1 request/ })).toBeDisabled()
    await fireEvent.input(screen.getByLabelText('Iterations'), { target: { value: '3' } })
    expect(screen.getByRole('button', { name: 'Run 1 request × 3' })).toBeEnabled()
    const bad = new File(['a,b\n1\n'], 'bad.csv', { type: 'text/csv' })
    await fireEvent.change(screen.getByLabelText('Data file'), { target: { files: [bad] } })
    expect(await screen.findByText('bad.csv: Line 2 has 1 value, the header has 2 columns.')).toBeInTheDocument()
    // With a data file, at most one iteration per row.
    const good = new File(['[{"a":1},{"a":2}]'], 'rows.json', { type: 'application/json' })
    await fireEvent.change(screen.getByLabelText('Data file'), { target: { files: [good] } })
    await waitFor(() => expect(screen.getByTestId('data-summary')).toHaveTextContent('2 rows · 1 column'))
    await fireEvent.input(screen.getByLabelText('Iterations'), { target: { value: '5' } })
    expect(screen.getByText(/from 1 to 2 \(one per data row at most\)/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByLabelText('Iterations')).toHaveValue(1)
  })

  it('switching workspaces stops the runs of the workspace left, and says so', async () => {
    const mock = await setup([['Slow', `${H}/slow`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request' }))
    await waitFor(() => expect(execCount(mock)).toBe(1))
    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }))
    expect(runsStore.switchWarning()).toBe('The run of "Runner col" is still going. It needs this workspace, so switching stops it.')
    const other = await mock.createWorkspace('Other')
    await app.refreshWorkspaces()
    await app.selectWorkspace(other.id)
    await waitFor(() => expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(1))
    expect(runsStore.sessions).toHaveLength(0)
    expect(toast.items.map((t) => t.title)).toContain('Stopped the run of "Runner col"')
    expect(toast.items.some((t) => t.title.startsWith('Run finished'))).toBe(false)
  })
})
