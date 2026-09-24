import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import RunnerDialog from './RunnerDialog.svelte'

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
  return mock
}

beforeEach(() => {
  ui.runner = null
})

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
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    const summary = await screen.findByTestId('summary', {}, { timeout: 2000 })
    expect(summary).toHaveTextContent('(stopped)')
    expect(summary).toHaveTextContent('2 skipped')
    expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(1)
    expect(mock.calls.filter((c) => c.method === 'executeHttpRequest')).toHaveLength(1)
  })

  it('closing while running asks for confirmation, then stops the run', async () => {
    const mock = await setup([['Slow', `${H}/slow`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request' }))
    await waitFor(() => expect(mock.calls.some((c) => c.method === 'executeHttpRequest')).toBe(true))
    await fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop and close' }))
    await waitFor(() => expect(ui.runner).toBeNull(), { timeout: 2000 })
    expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(1)
  })

  it('unmounting while running cancels the in-flight request', async () => {
    const mock = await setup([['Slow', `${H}/slow`]])
    await fireEvent.click(screen.getByRole('button', { name: 'Run 1 request' }))
    await waitFor(() => expect(mock.calls.some((c) => c.method === 'executeHttpRequest')).toBe(true))
    ui.runner = null
    await waitFor(() => expect(mock.calls.filter((c) => c.method === 'cancelHttpRequest')).toHaveLength(1))
  })
})
