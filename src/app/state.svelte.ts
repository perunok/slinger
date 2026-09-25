/**
 * Workspace-level application state: workspaces, collections/folders/requests,
 * environments and the active environment (which defines the template scope).
 * Every IPC failure is reported through a toast; nothing throws to callers.
 */
import type { ApiFolder, ApiRequest, Collection, Environment, EnvironmentVariable, Workspace } from '../../shared/types'
import { api, errorInfo, isReadOnly } from '../lib/ipc'
import { makeScope } from '../lib/template'
import { scopeStore } from './scope.svelte'
import { toast } from './toast.svelte'

const LS_WORKSPACE = 'slinger.workspace'
const lsKeyEnv = (ws: string) => `slinger.activeEnv.${ws}`

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function lsSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

class AppState {
  ready = $state(false)
  loading = $state(false)
  fatalError = $state<string | null>(null)

  workspaces = $state<Workspace[]>([])
  workspaceId = $state<string | null>(null)

  collections = $state<Collection[]>([])
  folders = $state<ApiFolder[]>([])
  requests = $state<ApiRequest[]>([])

  /** Bumped whenever something was executed, so the history panel refreshes. */
  historyTick = $state(0)

  environments = $state<Environment[]>([])
  activeEnvironmentId = $state<string | null>(null)
  envVariables = $state<EnvironmentVariable[]>([])

  workspace = $derived(this.workspaces.find((w) => w.id === this.workspaceId) ?? null)
  activeEnvironment = $derived(this.environments.find((e) => e.id === this.activeEnvironmentId) ?? null)

  /** Registered by the tabs store: reconcile open tabs whenever requests were reloaded. */
  onRequestsReloaded: (() => void) | null = null
  /** Registered by cloud sync: local data was (re)loaded after a write, so the pending-change count may have changed. */
  onLocalData: (() => void) | null = null

  foldersOf(collectionId: string): ApiFolder[] {
    return this.folders.filter((f) => f.collectionId === collectionId)
  }
  requestsOf(collectionId: string): ApiRequest[] {
    return this.requests.filter((r) => r.collectionId === collectionId)
  }
  requestById(id: string | null | undefined): ApiRequest | undefined {
    return id ? this.requests.find((r) => r.id === id) : undefined
  }

  // ---- boot -------------------------------------------------------------

  async init() {
    this.loading = true
    try {
      await this.loadWorkspaces()
      this.fatalError = null
    } catch (e) {
      this.fatalError = errorInfo(e).message
    } finally {
      this.loading = false
      this.ready = true
    }
  }

  async loadWorkspaces() {
    let list = await api().listWorkspaces()
    if (list.length === 0) {
      list = [await api().createWorkspace('My Workspace')]
    }
    this.workspaces = list
    const saved = lsGet(LS_WORKSPACE)
    const target = list.find((w) => w.id === saved) ?? list[0]
    await this.selectWorkspace(target.id)
  }

  async selectWorkspace(id: string) {
    this.workspaceId = id
    lsSet(LS_WORKSPACE, id)
    this.collections = []
    this.folders = []
    this.requests = []
    await Promise.all([this.reloadCollections(), this.reloadEnvironments()])
  }

  async refreshWorkspaces() {
    try {
      this.workspaces = await api().listWorkspaces()
    } catch (e) {
      toast.error('Could not refresh workspaces', errorInfo(e).message)
    }
  }

  // ---- collections ------------------------------------------------------

  async reloadCollections(): Promise<void> {
    const ws = this.workspaceId
    if (!ws) return
    try {
      const cols = await api().listCollections(ws)
      const perCollection = await Promise.all(
        cols.map(async (c) => {
          const [f, r] = await Promise.all([api().listFolders(c.id), api().listRequests(c.id)])
          return { f, r }
        }),
      )
      if (this.workspaceId !== ws) return // switched meanwhile
      this.collections = cols
      this.folders = perCollection.flatMap((x) => x.f)
      this.requests = perCollection.flatMap((x) => x.r)
      this.onRequestsReloaded?.()
      this.onLocalData?.()
    } catch (e) {
      toast.error('Could not load collections', errorInfo(e).message)
    }
  }

  /**
   * Replaces the folders + requests of the given collections. All lists are fetched first and
   * assigned together, then open tabs are reconciled once (a half-updated state must never look
   * like "request deleted").
   */
  async reloadCollectionsById(collectionIds: string[]): Promise<void> {
    const ids = [...new Set(collectionIds)]
    try {
      const loaded = await Promise.all(
        ids.map(async (id) => {
          const [f, r] = await Promise.all([api().listFolders(id), api().listRequests(id)])
          return { id, f, r }
        }),
      )
      const set = new Set(ids)
      this.folders = [...this.folders.filter((x) => !set.has(x.collectionId)), ...loaded.flatMap((x) => x.f)]
      this.requests = [...this.requests.filter((x) => !set.has(x.collectionId)), ...loaded.flatMap((x) => x.r)]
      this.onRequestsReloaded?.()
      this.onLocalData?.()
    } catch (e) {
      toast.error('Could not refresh collection', errorInfo(e).message)
    }
  }

  reloadCollection(collectionId: string): Promise<void> {
    return this.reloadCollectionsById([collectionId])
  }

  upsertRequest(req: ApiRequest) {
    const i = this.requests.findIndex((r) => r.id === req.id)
    if (i >= 0) this.requests[i] = req
    else this.requests.push(req)
    this.onLocalData?.()
  }
  /** Replaces one collection / folder after a single-entity write (e.g. its description). */
  upsertCollection(c: Collection) {
    const i = this.collections.findIndex((x) => x.id === c.id)
    if (i >= 0) this.collections[i] = c
    else this.collections.push(c)
    this.onLocalData?.()
  }
  upsertFolder(f: ApiFolder) {
    const i = this.folders.findIndex((x) => x.id === f.id)
    if (i >= 0) this.folders[i] = f
    else this.folders.push(f)
    this.onLocalData?.()
  }
  removeRequestLocal(id: string) {
    this.requests = this.requests.filter((r) => r.id !== id)
  }

  // ---- environments -----------------------------------------------------

  async reloadEnvironments(): Promise<void> {
    const ws = this.workspaceId
    if (!ws) return
    try {
      let envs = await api().listEnvironments(ws)
      if (envs.length === 0) {
        // A read-only workspace cannot get a default environment; showing none is correct there.
        try {
          envs = [await api().ensureDefaultEnvironment(ws)]
        } catch (e) {
          if (!isReadOnly(e)) throw e
        }
      }
      if (this.workspaceId !== ws) return
      this.environments = envs
      const saved = lsGet(lsKeyEnv(ws))
      const keep = envs.find((e) => e.id === this.activeEnvironmentId && e.workspaceId === ws)
      const next = keep ?? envs.find((e) => e.id === saved) ?? envs[0] ?? null
      await this.setActiveEnvironment(next?.id ?? null)
    } catch (e) {
      toast.error('Could not load environments', errorInfo(e).message)
    }
  }

  async setActiveEnvironment(id: string | null) {
    this.activeEnvironmentId = id
    if (this.workspaceId) lsSet(lsKeyEnv(this.workspaceId), id)
    await this.refreshEnvVariables()
  }

  /** Reloads the active environment's variables and republishes the template scope. */
  async refreshEnvVariables(): Promise<void> {
    const id = this.activeEnvironmentId
    if (!id) {
      this.envVariables = []
      this.publishScope()
      return
    }
    try {
      const vars = await api().listEnvironmentVariables(id)
      if (this.activeEnvironmentId !== id) return
      this.envVariables = vars
    } catch (e) {
      this.envVariables = []
      toast.error('Could not load environment variables', errorInfo(e).message)
    }
    this.publishScope()
    this.onLocalData?.()
  }

  publishScope() {
    const env = this.activeEnvironment
    scopeStore.scope = makeScope(
      env?.name ?? null,
      this.envVariables.map((v) => ({ key: v.key, value: v.isSecret ? null : (v.value ?? ''), secret: v.isSecret, id: v.id })),
    )
  }
}

export const app = new AppState()
