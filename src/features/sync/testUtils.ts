/** Shared setup for sync UI tests: mock backend as window.slinger, app + sync stores initialised against it. */
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { tabsStore } from '../requests/tabs.svelte'
import { sync } from './syncStore.svelte'

export type Backend = ReturnType<typeof createMockBackend>

export async function setupSync(opts: { seed?: boolean } = {}): Promise<Backend> {
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0, seed: opts.seed ?? true })
  window.slinger = backend
  window.__slingerMock = backend
  sync.reset()
  toast.clear()
  tabsStore.tabs = []
  ui.conflictsOpen = false
  ui.publishOpen = false
  ui.linkOpen = null
  ui.cloudOpen = false
  await app.init()
  await sync.init()
  return backend
}

export function teardownSync(): void {
  sync.reset()
  toast.clear()
  tabsStore.tabs = []
  ui.conflictsOpen = false
  ui.publishOpen = false
  ui.linkOpen = null
  ui.cloudOpen = false
}

export async function signInMock(b: Backend): Promise<void> {
  await b.startCloudSignIn()
  b.cloud.approveSignIn()
  await flush()
}

/** Lets pending promise chains and the store's 150 ms applied-event coalescing settle. */
export const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms))

export async function selectWorkspaceByName(name: string): Promise<string> {
  await app.refreshWorkspaces()
  const ws = app.workspaces.find((w) => w.name === name)!
  await app.selectWorkspace(ws.id)
  return ws.id
}
