/**
 * Mock servers in the renderer: which collections are being served (all workspaces), their request logs, and the
 * start / stop / options / clear actions. The servers themselves run in the main process (electron/services/mockServers.ts);
 * this store mirrors them through `listMockServers` and the `onMockServerEvent` push channel (nothing polls). Examples are
 * resolved here from the request documents (lib/mockServers.ts) and pushed again when the collection changes
 * (`refreshExamples`, driven by MockServersHost).
 *
 * Remembered per collection in localStorage (lib/mockServers.ts `MockSettings`): the last port, the options and "start
 * again when Slinger starts", plus the list of servers that were running when Slinger last quit. On init those are
 * started again (from any workspace: their trees are loaded through IPC, not from the open workspace).
 */
import {
  MOCK_LOG_LIMIT,
  type MockServerEvent,
  type MockServerInfo,
  type MockServerLogEntry,
  type MockServerOptions,
} from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { api, errorInfo } from '../../lib/ipc'
import {
  collectMockExamples,
  collectionMockSettings,
  loadMockSettings,
  mockSourceKey,
  normalizeMockOptions,
  suggestPort,
  updateMockSettings,
  withCollectionSettings,
  withoutCollection,
  withRunning,
  type MockCollectionSettings,
  type MockSettings,
} from '../../lib/mockServers'
import type { ApiFolder, ApiRequest } from '../../../shared/types'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** What was sent to main for a collection: its tree's source key and its name (a rename is sent too). */
const sentKey = (folders: ApiFolder[], requests: ApiRequest[], name: string) => `${mockSourceKey(folders, requests)}|${name}`

class MockServersStore {
  /** Running servers by collection id. */
  servers = $state<Record<string, MockServerInfo>>({})
  /** Request log per collection (kept after a stop, until the next start or Clear). */
  logs = $state<Record<string, MockServerLogEntry[]>>({})
  /** Start/stop in progress per collection. */
  busy = $state<Record<string, boolean>>({})
  /** The last start / options failure per collection (port in use, ...), shown in the dialog. */
  errors = $state<Record<string, string | null>>({})
  /** What is remembered in localStorage (mirrored here so the dialog follows changes). */
  settings = $state<MockSettings>(loadMockSettings(storage()))

  list = $derived(Object.values(this.servers).sort((a, b) => a.port - b.port))

  #off: (() => void) | null = null
  /** What was last sent to main per collection (`sentKey`), so unchanged collections are not re-sent. */
  #sent = new Map<string, string>()

  /**
   * Subscribes to main's events, loads the running servers (after a page reload they are still running), then starts
   * the ones that were running when Slinger last quit. `ready` settles when all of that is done.
   */
  init(): () => void {
    this.#off?.()
    this.#off = api().onMockServerEvent?.((e) => this.apply(e)) ?? null
    this.settings = loadMockSettings(storage())
    this.ready = this.load().then((ok) => (ok ? this.restore() : undefined))
    return () => {
      this.#off?.()
      this.#off = null
    }
  }

  /** Settles when the last `init` finished loading and restoring (tests). */
  ready: Promise<void> = Promise.resolve()

  async load(): Promise<boolean> {
    try {
      const list = await api().listMockServers()
      this.servers = Object.fromEntries(list.map((s) => [s.collectionId, s]))
      const logs = await Promise.all(list.map(async (s) => [s.collectionId, await api().getMockServerLog(s.collectionId)] as const))
      this.logs = { ...this.logs, ...Object.fromEntries(logs) }
      return true
    } catch (e) {
      toast.error('Could not load mock servers', errorInfo(e).message)
      return false
    }
  }

  #remember(fn: (s: MockSettings) => MockSettings): void {
    this.settings = updateMockSettings(storage(), fn)
  }

  #setRunning(collectionId: string, workspaceId: string, running: boolean): void {
    const listed = loadMockSettings(storage()).running.find((r) => r.collectionId === collectionId)
    if (running ? listed?.workspaceId === workspaceId : !listed) return
    this.#remember((s) => withRunning(s, { collectionId, workspaceId }, running))
  }

  apply(e: MockServerEvent): void {
    if (e.type === 'started') {
      this.servers = { ...this.servers, [e.server.collectionId]: e.server }
      this.#setRunning(e.server.collectionId, e.server.workspaceId, true)
    } else if (e.type === 'updated') {
      const id = e.server.collectionId
      const current = this.servers[id]
      if (!current) return
      this.servers = { ...this.servers, [id]: { ...e.server, requestCount: Math.max(e.server.requestCount, current.requestCount) } }
      this.#remember((s) => withCollectionSettings(s, id, { options: e.server.options }))
    } else if (e.type === 'stopped') {
      // 'replaced': it moved to another port and a 'started' says the rest. 'quit': it starts again next time.
      if (e.by === 'replaced') return
      if (e.by === 'user' || e.by === 'error') this.#setRunning(e.collectionId, '', false)
      if (!this.servers[e.collectionId]) return
      const { [e.collectionId]: _gone, ...rest } = this.servers
      this.servers = rest
      this.#sent.delete(e.collectionId)
      if (e.by === 'error') toast.error('Mock server stopped', e.reason ?? 'The server failed.')
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

  /** The collection's remembered settings (defaults when none). */
  settingsFor(collectionId: string): MockCollectionSettings {
    return collectionMockSettings(this.settings, collectionId)
  }

  /** Options in effect: the running server's, else the remembered ones used at the next start. */
  optionsFor(collectionId: string): MockServerOptions {
    return this.servers[collectionId]?.options ?? this.settingsFor(collectionId).options
  }

  /** The port the dialog offers: the one last used for this collection, else the first not used by another mock. */
  suggestedPort(collectionId: string): number {
    const running = this.servers[collectionId]
    if (running) return running.port
    const used = new Set(this.list.map((s) => s.port))
    return suggestPort(collectionMockSettings(loadMockSettings(storage()), collectionId).port ?? undefined, used)
  }

  #examples(collectionId: string, name: string) {
    const folders = app.foldersOf(collectionId)
    const requests = app.requestsOf(collectionId)
    return { key: sentKey(folders, requests, name), examples: collectMockExamples(folders, requests) }
  }

  /** Number of saved examples the collection would serve. */
  exampleCount(collectionId: string): number {
    return collectMockExamples(app.foldersOf(collectionId), app.requestsOf(collectionId)).length
  }

  /** Starts serving the collection's current examples with its remembered options; false (with `errors[id]` set) when it failed. */
  async start(collectionId: string, port: number): Promise<boolean> {
    const workspaceId = app.workspaceId
    if (!workspaceId || this.busy[collectionId]) return false
    const collection = app.collections.find((c) => c.id === collectionId)
    if (!collection) {
      this.errors = { ...this.errors, [collectionId]: 'Open the workspace of this collection to start its mock server.' }
      return false
    }
    this.busy = { ...this.busy, [collectionId]: true }
    this.errors = { ...this.errors, [collectionId]: null }
    this.#starting.set(collectionId, workspaceId)
    try {
      const { key, examples } = this.#examples(collectionId, collection.name)
      const options = this.settingsFor(collectionId).options
      const info = await api().startMockServer({ workspaceId, collectionId, collectionName: collection.name, port, examples, options })
      this.#started(info, key)
      return true
    } catch (e) {
      // Stopped (collection or workspace deleted) while starting: not an error.
      const err = errorInfo(e)
      if ((err.details as { reason?: unknown } | undefined)?.reason !== 'stopped') this.errors = { ...this.errors, [collectionId]: err.message }
      return false
    } finally {
      this.#starting.delete(collectionId)
      this.busy = { ...this.busy, [collectionId]: false }
    }
  }

  /** Collections whose start is in flight, with their workspace (a delete meanwhile must cancel it in main). */
  #starting = new Map<string, string>()

  #started(info: MockServerInfo, key: string): void {
    const id = info.collectionId
    // The same server given new examples (main keeps its log) vs a new server (on another port: a fresh log).
    const same = this.servers[id]?.port === info.port
    this.#sent.set(id, key)
    this.servers = { ...this.servers, [id]: info }
    if (!same) this.logs = { ...this.logs, [id]: [] }
    this.#remember((s) =>
      withRunning(withCollectionSettings(s, id, { port: info.port, options: info.options }), { collectionId: id, workspaceId: info.workspaceId }, true),
    )
  }

  /**
   * Changes CORS and delay: remembered for the next start, and applied live when the server runs (false with `errors[id]`
   * set when that failed).
   */
  async setOptions(collectionId: string, options: MockServerOptions): Promise<boolean> {
    const next = normalizeMockOptions(options)
    this.#remember((s) => withCollectionSettings(s, collectionId, { options: next }))
    if (!this.servers[collectionId]) return true
    this.errors = { ...this.errors, [collectionId]: null }
    try {
      const info = await api().setMockServerOptions(collectionId, next)
      const current = this.servers[collectionId]
      if (current) this.servers = { ...this.servers, [collectionId]: { ...current, options: info.options } }
      return true
    } catch (e) {
      if (errorInfo(e).code === 'not_found') return true
      this.errors = { ...this.errors, [collectionId]: errorInfo(e).message }
      return false
    }
  }

  /** "Start again when Slinger starts" (remembered only). */
  setStartWithSlinger(collectionId: string, on: boolean): void {
    this.#remember((s) => withCollectionSettings(s, collectionId, { startWithSlinger: on }))
  }

  async stop(collectionId: string): Promise<void> {
    if (this.busy[collectionId]) return
    this.busy = { ...this.busy, [collectionId]: true }
    try {
      await api().stopMockServer(collectionId)
      this.apply({ type: 'stopped', collectionId, reason: null, by: 'user' })
    } catch (e) {
      toast.error('Could not stop the mock server', errorInfo(e).message)
    } finally {
      this.busy = { ...this.busy, [collectionId]: false }
    }
  }

  /** The collection is being deleted: stops its server quietly and forgets its settings. */
  async stopIfRunning(collectionId: string): Promise<void> {
    if (this.servers[collectionId]) await this.stop(collectionId)
    else if (this.#starting.has(collectionId)) await api().stopMockServer(collectionId).catch(() => {}) // cancels the start
    this.#remember((s) => withoutCollection(s, collectionId))
  }

  /** The workspace is being deleted: stops its servers and drops them from the running list. */
  async stopWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(this.list.filter((s) => s.workspaceId === workspaceId).map((s) => this.stop(s.collectionId)))
    const starting = [...this.#starting].filter(([, ws]) => ws === workspaceId).map(([id]) => id)
    await Promise.all(starting.map((id) => api().stopMockServer(id).catch(() => {}))) // cancels those starts
    this.#remember((s) => ({ ...s, running: s.running.filter((r) => r.workspaceId !== workspaceId) }))
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
   * Sends the examples (and the name, after a rename) of running servers whose collection changed (live reload). Only
   * collections of the open workspace whose tree is loaded are considered, so a workspace switch never sends an empty list.
   */
  async refreshExamples(): Promise<void> {
    for (const server of this.list) {
      const id = server.collectionId
      const collection = app.collections.find((c) => c.id === id)
      if (server.workspaceId !== app.workspaceId || !collection || this.busy[id]) continue
      const { key, examples } = this.#examples(id, collection.name)
      if (this.#sent.get(id) === key) continue
      this.#sent.set(id, key)
      try {
        const renamed = collection.name !== server.collectionName
        const info = renamed ? await api().updateMockServer(id, examples, collection.name) : await api().updateMockServer(id, examples)
        const current = this.servers[id]
        if (current) this.servers = { ...this.servers, [id]: { ...current, exampleCount: info.exampleCount, collectionName: info.collectionName } }
      } catch (e) {
        // Stopped meanwhile (not_found) needs no message; anything else does.
        if (errorInfo(e).code !== 'not_found') toast.error('Could not update the mock server', errorInfo(e).message)
      }
    }
  }

  /**
   * Start with Slinger: every server that was running when Slinger last quit, is not running now and is not switched off
   * starts again on its port with its options. Its collection may be in another workspace, so the tree is loaded through
   * IPC. A collection that is gone is dropped quietly; any other failure (port in use, ...) is one toast naming it, and
   * either way it leaves the running list.
   */
  async restore(): Promise<void> {
    const settings = loadMockSettings(storage())
    for (const entry of settings.running) {
      const id = entry.collectionId
      if (this.servers[id] || this.busy[id]) continue
      const remembered = collectionMockSettings(settings, id)
      const drop = () => this.#setRunning(id, entry.workspaceId, false)
      if (!remembered.startWithSlinger || remembered.port === null) {
        drop()
        continue
      }
      let name: string | null = null
      this.busy = { ...this.busy, [id]: true }
      try {
        const collection = (await api().listCollections(entry.workspaceId)).find((c) => c.id === id)
        if (!collection) {
          drop()
          continue
        }
        name = collection.name
        const [folders, requests] = await Promise.all([api().listFolders(id), api().listRequests(id)])
        const info = await api().startMockServer({
          workspaceId: entry.workspaceId,
          collectionId: id,
          collectionName: collection.name,
          port: remembered.port,
          examples: collectMockExamples(folders, requests),
          options: remembered.options,
        })
        this.#started(info, sentKey(folders, requests, collection.name))
      } catch (e) {
        drop()
        const err = errorInfo(e)
        if (err.code !== 'not_found') toast.error(name ? `Could not start the mock server of “${name}”` : 'Could not start a mock server', err.message)
      } finally {
        this.busy = { ...this.busy, [id]: false }
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
    this.settings = loadMockSettings(storage())
    this.ready = Promise.resolve()
  }
}

export const mockServers = new MockServersStore()
