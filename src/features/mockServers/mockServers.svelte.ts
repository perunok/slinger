/**
 * Mock servers in the renderer: which collections are being served (all workspaces), their request logs, and the
 * start / stop / clear actions. The servers themselves run in the main process (electron/services/mockServers.ts); this
 * store mirrors them through `listMockServers` and the `onMockServerEvent` push channel (nothing polls). Examples are
 * resolved here from the loaded request documents (lib/mockServers.ts) and pushed again when the collection changes
 * (`refreshExamples`, driven by MockServersHost).
 */
import { MOCK_LOG_LIMIT, type MockServerEvent, type MockServerInfo, type MockServerLogEntry } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { collectMockExamples, loadMockPorts, mockSourceKey, saveMockPort, suggestPort } from '../../lib/mockServers'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

class MockServersStore {
  /** Running servers by collection id. */
  servers = $state<Record<string, MockServerInfo>>({})
  /** Request log per collection (kept after a stop, until the next start or Clear). */
  logs = $state<Record<string, MockServerLogEntry[]>>({})
  /** Start/stop in progress per collection. */
  busy = $state<Record<string, boolean>>({})
  /** The last start failure per collection (port in use, ...), shown in the dialog. */
  errors = $state<Record<string, string | null>>({})

  list = $derived(Object.values(this.servers).sort((a, b) => a.port - b.port))

  #off: (() => void) | null = null
  /** What was last sent to main per collection (mockSourceKey), so unchanged collections are not re-sent. */
  #sent = new Map<string, string>()

  /** Subscribes to main's events and loads the running servers (after a page reload they are still running). */
  init(): () => void {
    this.#off?.()
    this.#off = api().onMockServerEvent?.((e) => this.apply(e)) ?? null
    void this.load()
    return () => {
      this.#off?.()
      this.#off = null
    }
  }

  async load(): Promise<void> {
    try {
      const list = await api().listMockServers()
      this.servers = Object.fromEntries(list.map((s) => [s.collectionId, s]))
      const logs = await Promise.all(list.map(async (s) => [s.collectionId, await api().getMockServerLog(s.collectionId)] as const))
      this.logs = { ...this.logs, ...Object.fromEntries(logs) }
    } catch (e) {
      toast.error('Could not load mock servers', errorInfo(e).message)
    }
  }

  apply(e: MockServerEvent): void {
    if (e.type === 'started') {
      this.servers = { ...this.servers, [e.server.collectionId]: e.server }
    } else if (e.type === 'stopped') {
      if (!this.servers[e.collectionId]) return
      const { [e.collectionId]: _gone, ...rest } = this.servers
      this.servers = rest
      this.#sent.delete(e.collectionId)
      if (e.reason && e.reason !== 'app quit') toast.error('Mock server stopped', e.reason)
    } else {
      const server = this.servers[e.collectionId]
      if (server) this.servers = { ...this.servers, [e.collectionId]: { ...server, requestCount: e.requestCount } }
      const log = [...(this.logs[e.collectionId] ?? []), e.entry]
      this.logs = { ...this.logs, [e.collectionId]: log.length > MOCK_LOG_LIMIT ? log.slice(log.length - MOCK_LOG_LIMIT) : log }
    }
  }

  running(collectionId: string): MockServerInfo | null {
    return this.servers[collectionId] ?? null
  }

  /** The port the dialog offers: the one last used for this collection, else the first not used by another mock. */
  suggestedPort(collectionId: string): number {
    const running = this.servers[collectionId]
    if (running) return running.port
    const used = new Set(this.list.map((s) => s.port))
    return suggestPort(loadMockPorts(storage())[collectionId], used)
  }

  #examples(collectionId: string) {
    const folders = app.foldersOf(collectionId)
    const requests = app.requestsOf(collectionId)
    return { key: mockSourceKey(folders, requests), examples: collectMockExamples(folders, requests) }
  }

  /** Number of saved examples the collection would serve. */
  exampleCount(collectionId: string): number {
    return collectMockExamples(app.foldersOf(collectionId), app.requestsOf(collectionId)).length
  }

  /** Starts serving the collection's current examples; false (with `errors[id]` set) when it failed. */
  async start(collectionId: string, port: number): Promise<boolean> {
    const workspaceId = app.workspaceId
    if (!workspaceId || this.busy[collectionId]) return false
    if (!app.collections.some((c) => c.id === collectionId)) {
      this.errors = { ...this.errors, [collectionId]: 'Open the workspace of this collection to start its mock server.' }
      return false
    }
    this.busy = { ...this.busy, [collectionId]: true }
    this.errors = { ...this.errors, [collectionId]: null }
    try {
      const { key, examples } = this.#examples(collectionId)
      const info = await api().startMockServer({ workspaceId, collectionId, port, examples })
      this.#sent.set(collectionId, key)
      this.servers = { ...this.servers, [collectionId]: info }
      this.logs = { ...this.logs, [collectionId]: [] }
      saveMockPort(storage(), collectionId, info.port)
      return true
    } catch (e) {
      this.errors = { ...this.errors, [collectionId]: errorInfo(e).message }
      return false
    } finally {
      this.busy = { ...this.busy, [collectionId]: false }
    }
  }

  async stop(collectionId: string): Promise<void> {
    if (this.busy[collectionId]) return
    this.busy = { ...this.busy, [collectionId]: true }
    try {
      await api().stopMockServer(collectionId)
      this.apply({ type: 'stopped', collectionId, reason: null })
    } catch (e) {
      toast.error('Could not stop the mock server', errorInfo(e).message)
    } finally {
      this.busy = { ...this.busy, [collectionId]: false }
    }
  }

  /** Stops quietly if running (the collection or its workspace is being deleted). */
  async stopIfRunning(collectionId: string): Promise<void> {
    if (this.servers[collectionId]) await this.stop(collectionId)
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(this.list.filter((s) => s.workspaceId === workspaceId).map((s) => this.stop(s.collectionId)))
  }

  async clearLog(collectionId: string): Promise<void> {
    try {
      if (this.servers[collectionId]) await api().clearMockServerLog(collectionId)
      this.logs = { ...this.logs, [collectionId]: [] }
    } catch (e) {
      toast.error('Could not clear the log', errorInfo(e).message)
    }
  }

  /**
   * Sends the examples of running servers whose collection changed (live reload). Only collections of the open workspace
   * whose tree is loaded are considered, so a workspace switch never sends an empty list.
   */
  async refreshExamples(): Promise<void> {
    const loaded = new Set(app.collections.map((c) => c.id))
    for (const server of this.list) {
      const id = server.collectionId
      if (server.workspaceId !== app.workspaceId || !loaded.has(id) || this.busy[id]) continue
      const { key, examples } = this.#examples(id)
      if (this.#sent.get(id) === key) continue
      this.#sent.set(id, key)
      try {
        const info = await api().updateMockServer(id, examples)
        if (this.servers[id]) this.servers = { ...this.servers, [id]: { ...this.servers[id]!, exampleCount: info.exampleCount } }
      } catch (e) {
        // Stopped meanwhile (not_found) needs no message; anything else does.
        if (errorInfo(e).code !== 'not_found') toast.error('Could not update the mock server', errorInfo(e).message)
      }
    }
  }

  /** Tests. */
  reset(): void {
    this.#off?.()
    this.#off = null
    this.#sent.clear()
    this.servers = {}
    this.logs = {}
    this.busy = {}
    this.errors = {}
  }
}

export const mockServers = new MockServersStore()
