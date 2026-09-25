import { cleanup, render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import TabNoticeBanner from './TabNoticeBanner.svelte'
import { setupSync, teardownSync, type Backend } from './testUtils'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
})

describe('TabNoticeBanner', () => {
  it('renders nothing without a notice, or for a clean tab with a "changed" notice', () => {
    const tab = tabsStore.openRequest(app.requests[0]!)
    render(TabNoticeBanner, { tab })
    expect(screen.queryByTestId('tab-notice')).toBeNull()
    tab.remoteNotice = { kind: 'changed', server: app.requests[0]! }
    expect(tab.dirty).toBe(false)
    return Promise.resolve().then(() => expect(screen.queryByTestId('tab-notice')).toBeNull())
  })

  it('changed: "Reload from cloud" drops my edits and loads the stored version', async () => {
    const user = userEvent.setup()
    const req = app.requests[0]!
    const tab = tabsStore.openRequest(req)
    tab.draft.url = 'https://mine.example'
    const updated = await b.updateRequest({ requestId: req.id, name: req.name, method: req.method, url: 'https://cloud.example', documentJson: JSON.stringify({ ...JSON.parse(req.documentJson), url: 'https://cloud.example' }), expectedVersion: req.version })
    app.upsertRequest(updated)
    tab.remoteNotice = { kind: 'changed', server: updated }
    render(TabNoticeBanner, { tab })
    expect(await screen.findByTestId('tab-notice')).toHaveTextContent('unsaved edits are untouched'.replace('unsaved edits are', 'edits are'))
    await user.click(screen.getByRole('button', { name: 'Reload from cloud' }))
    expect(tab.draft.url).toBe('https://cloud.example')
    expect(tab.dirty).toBe(false)
    expect(tab.remoteNotice).toBeNull()
  })

  it('changed: "Keep my edits" rebases on the stored version so the next save overwrites on purpose', async () => {
    const user = userEvent.setup()
    const req = app.requests[0]!
    const tab = tabsStore.openRequest(req)
    tab.draft.url = 'https://mine.example'
    const updated = await b.updateRequest({ requestId: req.id, name: req.name, method: req.method, url: 'https://cloud.example', documentJson: JSON.stringify({ ...JSON.parse(req.documentJson), url: 'https://cloud.example' }), expectedVersion: req.version })
    app.upsertRequest(updated)
    tab.remoteNotice = { kind: 'changed', server: updated }
    render(TabNoticeBanner, { tab })
    await user.click(await screen.findByRole('button', { name: 'Keep my edits' }))
    expect(tab.draft.url).toBe('https://mine.example')
    expect(tab.baseVersion).toBe(updated.version)
    expect(tab.remoteNotice).toBeNull()
    expect(await tabsStore.save(tab)).toBe(true) // no version_conflict
    expect((await b.listRequests(req.collectionId)).find((r) => r.id === req.id)?.url).toBe('https://mine.example')
  })

  it('deleted: keeps the tab, offers Save as new / Close', async () => {
    const user = userEvent.setup()
    const tab = tabsStore.openRequest(app.requests[0]!)
    tab.draft.name = 'unsaved work'
    tab.remoteNotice = { kind: 'deleted' }
    render(TabNoticeBanner, { tab })
    expect(await screen.findByTestId('tab-notice')).toHaveTextContent('deleted in the cloud')
    await user.click(screen.getByRole('button', { name: 'Save as new request…' }))
    expect(ui.saveAsTabId).toBe(tab.id)
    await user.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(tabsStore.pendingClose?.ids).toEqual([tab.id]) // dirty: asks before discarding
  })
})
