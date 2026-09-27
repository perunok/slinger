/** The "too big to sync" heads-up in the request/example editor (electron/sync/mapping.ts LIMITS.documentJsonBytes). */
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { tabsStore, type RequestTab } from '../requests/tabs.svelte'
import SyncSizeWarning from './SyncSizeWarning.svelte'
import { sync } from './syncStore.svelte'
import { setupSync, signInMock, teardownSync, type Backend } from './testUtils'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
})

/** Inflates a request draft's raw body well past the 900,000-byte cloud sync cap. */
function inflate(tab: RequestTab): void {
  tab.draft.body.kind = 'raw'
  tab.draft.body.raw = 'x'.repeat(1_000_000)
}

describe('SyncSizeWarning', () => {
  it('renders nothing for an unlinked workspace, even when the document is huge', () => {
    const tab = tabsStore.openRequest(app.requests[0]!)
    inflate(tab)
    render(SyncSizeWarning, { tab })
    expect(screen.queryByTestId('sync-size-warning')).toBeNull()
  })

  it('renders nothing for a linked workspace when the document fits the cap', async () => {
    await signInMock(b)
    await sync.publish(app.workspaceId!)
    const tab = tabsStore.openRequest(app.requests[0]!)
    render(SyncSizeWarning, { tab })
    expect(screen.queryByTestId('sync-size-warning')).toBeNull()
  })

  it('names the size and the 900 KB limit once a linked request crosses the cap', async () => {
    await signInMock(b)
    await sync.publish(app.workspaceId!)
    const tab = tabsStore.openRequest(app.requests[0]!)
    inflate(tab)
    render(SyncSizeWarning, { tab })
    const warning = await screen.findByTestId('sync-size-warning')
    expect(warning).toHaveTextContent('900 KB')
    expect(warning).toHaveTextContent('will not sync')
  })

  it('updates live as the draft shrinks back under the cap', async () => {
    await signInMock(b)
    await sync.publish(app.workspaceId!)
    const tab = tabsStore.openRequest(app.requests[0]!)
    inflate(tab)
    render(SyncSizeWarning, { tab })
    await screen.findByTestId('sync-size-warning')
    tab.draft.body.raw = 'small'
    await waitFor(() => expect(screen.queryByTestId('sync-size-warning')).toBeNull())
  })

  it('warns for an example tab too, projecting the edit into the parent document', async () => {
    await signInMock(b)
    await sync.publish(app.workspaceId!)
    const req = app.requests.find((r) => r.name === 'List pets')!
    const tab = tabsStore.openExample(req, 0)
    tab.exampleDraft!.body = 'x'.repeat(1_000_000)
    render(SyncSizeWarning, { tab })
    const warning = await screen.findByTestId('sync-size-warning')
    expect(warning).toHaveTextContent('900 KB')
  })
})
