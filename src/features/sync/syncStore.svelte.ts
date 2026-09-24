/**
 * Reactive cloud + sync state for the renderer. It is a thin wrapper over the IPC (`getCloudSession`,
 * `getSyncStatus`, ...) plus ONE `onSyncEvent` subscription; tokens and HTTP live in the main process.
 * Nothing here polls the main process: state changes arrive as events, the only timer is the 15 s tick that
 * refreshes "synced 2 min ago" labels locally.
 */
import type {
  CloudConfig,
  CloudSession,
  CloudSignInStart,
  LinkRemoteWorkspaceInput,
  RemoteWorkspace,
  RemoteWorkspacePreview,
  ResolveSyncConflictInput,
  SyncConflict,
  SyncEvent,
  SyncStatus,
  Workspace,
} from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { collectLegacy, dismissLegacyHint, type LegacyHint } from '../cloud/legacy'
import { tabsStore } from '../requests/tabs.svelte'
import { blockMessage, blockReason, deriveChip, type BlockReason } from './status'
import { affectedDirtyTabs, planNotices } from './tabNotices'

export type SignInPhase = 'idle' | 'starting' | 'waiting' | 'approved' | 'expired' | 'denied' | 'cancelled' | 'error'

export interface SignInState {
  phase: SignInPhase
  info: CloudSignInStart | null
  message: string | null
  /** Epoch seconds when the code stops working (for the countdown). */
  expiresAt: number | null
}

const idleSignIn = (): SignInState => ({ phase: 'idle', info: null, message: null, expiresAt: null })
const nowSec = () => Math.floor(Date.now() / 1000)

export class SyncStore {
  session = $state<CloudSession | null>(null)
  config = $state<CloudConfig | null>(null)
  statuses = $state<Record<string, SyncStatus>>({})
  signIn = $state<SignInState>(idleSignIn())
  remotes = $state<RemoteWorkspace[]>([])
  remotesLoading = $state(false)
  remotesError = $state<string | null>(null)
  /** Open conflicts of the workspace whose conflict center is (or was last) open. */
  conflicts = $state<SyncConflict[]>([])
  conflictsLoading = $state(false)
  /** Legacy renderer-side links found in localStorage: names only, shown once as a hint. */
  legacyLinks = $state<LegacyHint[]>([])
  /** Epoch seconds, refreshed locally so relative times stay current. */
  now = $state(nowSec())
  /** Workspace ids with a user-started action in flight (sync now, discard...). */
  busy = $state<Record<string, string | undefined>>({})

  #unsub: (() => void) | null = null
  #ticker: ReturnType<typeof setInterval> | null = null
  #reloadTimer: ReturnType<typeof setTimeout> | null = null
  #pendingApplied = new Map<string, { requests: Set<string>; environments: boolean; truncated: boolean }>()
  #initStarted = false
  #quiet = false
  #conflictToast: number | null = null
  #statusTimer: ReturnType<typeof setTimeout> | null = null

  current = $derived<SyncStatus | null>(app.workspaceId ? (this.statuses[app.workspaceId] ?? null) : null)
  chip = $derived(deriveChip(this.current, this.session, this.now))
  blockReason = $derived<BlockReason | null>(blockReason(this.current))
  /** Edits of the current workspace are disabled (read-only role or access revoked). */
  blocked = $derived(this.blockReason !== null)
  blockedMessage = $derived(this.blockReason ? blockMessage(this.blockReason, this.current) : '')
  signedIn = $derived(this.session?.status === 'signedIn')
  serverUnsupported = $derived(Object.values(this.statuses).some((s) => s.linked && s.state === 'serverUnsupported'))
  linkedCount = $derived(Object.values(this.statuses).filter((s) => s.linked).length)

  statusOf(workspaceId: string | null): SyncStatus | null {
    return workspaceId ? (this.statuses[workspaceId] ?? null) : null
  }
  /** True when edits in that workspace are disabled. */
  isBlocked(workspaceId: string | null): boolean {
    return blockReason(this.statusOf(workspaceId)) !== null
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Idempotent: subscribes to sync events and loads the initial state. */
  async init(): Promise<void> {
    if (this.#initStarted) return
    this.#initStarted = true
    this.#unsub = api().onSyncEvent((e) => this.handleEvent(e))
    app.onLocalData = () => this.#localDataChanged()
    this.#ticker = setInterval(() => (this.now = nowSec()), 15_000)
    await Promise.all([this.refreshSession(), this.refreshStatuses()])
    const legacy = collectLegacy(this.config)
    this.legacyLinks = legacy.hints
    if (legacy.config) {
      try {
        await this.saveConfig(legacy.config)
      } catch {
        /* invalid legacy value: keep the main-process config */
      }
    }
  }

  /** Drops all state and subscriptions (tests, and sign-out of the whole app). */
  reset(): void {
    this.dispose()
    this.session = null
    this.config = null
    this.statuses = {}
    this.signIn = idleSignIn()
    this.remotes = []
    this.remotesError = null
    this.conflicts = []
    this.legacyLinks = []
    this.busy = {}
    this.#pendingApplied.clear()
    this.#conflictToast = null
  }

  dismissLegacy(localWorkspaceId: string): void {
    dismissLegacyHint(localWorkspaceId)
    this.legacyLinks = this.legacyLinks.filter((h) => h.localWorkspaceId !== localWorkspaceId)
  }

  dispose(): void {
    this.#unsub?.()
    this.#unsub = null
    if (app.onLocalData) app.onLocalData = null
    if (this.#statusTimer) clearTimeout(this.#statusTimer)
    this.#statusTimer = null
    if (this.#ticker) clearInterval(this.#ticker)
    this.#ticker = null
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer)
    this.#reloadTimer = null
    this.#initStarted = false
  }

  async refreshSession(): Promise<void> {
    try {
      const [session, config] = await Promise.all([api().getCloudSession(), api().getCloudConfig()])
      this.session = session
      this.config = config
    } catch (e) {
      toast.error('Could not read the cloud session', errorInfo(e).message)
    }
  }

  async refreshStatuses(): Promise<void> {
    try {
      const list = await api().listSyncStatuses()
      const next: Record<string, SyncStatus> = { ...this.statuses }
      for (const s of list) next[s.workspaceId] = s
      this.statuses = next
    } catch (e) {
      toast.error('Could not read sync status', errorInfo(e).message)
    }
  }

  /** Loads the status of a workspace we have not seen yet (unlinked ones are not in listSyncStatuses). */
  async ensureStatus(workspaceId: string): Promise<void> {
    if (this.statuses[workspaceId]) return
    try {
      this.statuses[workspaceId] = await api().getSyncStatus(workspaceId)
    } catch {
      /* the chip simply stays hidden */
    }
  }

  /**
   * The user's own edits change the pending-change count without a cycle running (auto sync off, or before
   * the next scheduler tick), so re-read the status of the open workspace once things settle. Event-driven by
   * the user's writes, debounced, and only for linked workspaces: not polling.
   */
  #localDataChanged(): void {
    const id = app.workspaceId
    if (!id || !this.statuses[id]?.linked || this.#statusTimer) return
    this.#statusTimer = setTimeout(async () => {
      this.#statusTimer = null
      try {
        const fresh = await api().getSyncStatus(id)
        if (this.statuses[id]?.linked) this.statuses[id] = fresh
      } catch {
        /* the next event will bring the status */
      }
    }, 400)
  }

  // ---- events ---------------------------------------------------------------

  handleEvent(e: SyncEvent): void {
    switch (e.type) {
      case 'status': {
        const prev = this.statuses[e.status.workspaceId] ?? null
        this.statuses[e.status.workspaceId] = e.status
        this.#notifyStatus(prev, e.status)
        if (ui.conflictsOpen && e.status.workspaceId === app.workspaceId && prev && prev.openConflicts !== e.status.openConflicts) void this.loadConflicts()
        return
      }
      case 'applied':
        this.#queueApplied(e)
        return
      case 'conflicts':
        if (ui.conflictsOpen && e.workspaceId === app.workspaceId) void this.loadConflicts()
        return
      case 'auth': {
        const prev = this.session
        this.session = e.session
        if (prev?.status === 'signedIn' && e.session.status === 'signedOut' && this.linkedCount > 0 && this.signIn.phase !== 'waiting' && this.signIn.phase !== 'starting' && !this.#quiet) {
          toast.offer('Signed out of Slinger Cloud', 'Sign in again to keep syncing. Your changes are kept and will upload afterwards.', {
            label: 'Sign in',
            run: () => (ui.cloudOpen = true),
          })
        }
        if (e.session.status === 'signedIn') void this.refreshStatuses()
        else this.remotes = []
        return
      }
      case 'signInResult':
        this.#signInResult(e.result, e.message)
    }
  }

  #notifyStatus(prev: SyncStatus | null, next: SyncStatus): void {
    if (!next.linked) return
    const name = next.remoteName ?? 'workspace'
    if (next.state === 'error' && next.lastError && (prev?.state !== 'error' || prev.lastError?.message !== next.lastError.message)) {
      toast.push('error', `Sync of "${name}" failed`, next.lastError.message, 15000, { label: 'Retry', run: () => void this.syncNow(next.workspaceId) })
    }
    if (next.openConflicts > (prev?.openConflicts ?? 0) && !ui.conflictsOpen) {
      const n = next.openConflicts
      if (this.#conflictToast !== null) toast.dismiss(this.#conflictToast)
      this.#conflictToast = toast.offer(`${n} sync conflict${n === 1 ? '' : 's'}`, `Changes in "${name}" could not be merged automatically.`, {
        label: 'Review',
        run: () => void this.openConflicts(next.workspaceId),
      })
    }
    if (prev && prev.state !== 'accessRevoked' && next.state === 'accessRevoked') {
      toast.error('Cloud access lost', `You can no longer sync "${name}". Your local copy is kept.`)
    }
    if (prev && prev.linked && !prev.readOnly && next.readOnly) toast.info('Workspace is now read-only', `Your role in "${name}" changed to viewer.`)
    if (prev && prev.linked && prev.readOnly && !next.readOnly) toast.success('You can edit again', `Your role in "${name}" allows edits.`)
    if (prev && prev.state !== 'serverUnsupported' && next.state === 'serverUnsupported') {
      toast.error('Cloud server not supported', 'This server is too old for collection sync (protocol version 2 is required).')
    }
  }

  /** Coalesces `applied` events, refetches lists, and warns tabs whose request changed under unsaved edits. */
  #queueApplied(e: Extract<SyncEvent, { type: 'applied' }>): void {
    if (e.workspaceId !== app.workspaceId) return
    const acc = this.#pendingApplied.get(e.workspaceId) ?? { requests: new Set<string>(), environments: false, truncated: false }
    for (const c of e.changed) {
      if (c.entityType === 'request') acc.requests.add(c.entityId)
      if (c.entityType === 'environment' || c.entityType === 'environment_variable') acc.environments = true
    }
    acc.truncated ||= e.truncated
    this.#pendingApplied.set(e.workspaceId, acc)
    if (this.#reloadTimer) return
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null
      void this.#flushApplied()
    }, 150)
  }

  async #flushApplied(): Promise<void> {
    const ws = app.workspaceId
    const acc = ws ? this.#pendingApplied.get(ws) : undefined
    this.#pendingApplied.clear()
    if (!ws || !acc) return
    const facts = () => tabsStore.tabs.map((t) => ({ tabId: t.id, requestId: t.requestId, dirty: t.dirty, serverKey: t.serverKey }))
    const affected = affectedDirtyTabs(facts(), acc.requests, acc.truncated)
    const originals = new Map(tabsStore.tabs.filter((t) => affected.includes(t.id) && t.requestId).map((t) => [t.id, t.requestId as string]))
    await app.reloadCollections()
    if (acc.environments || acc.truncated) await app.reloadEnvironments()
    for (const [tabId, notice] of planNotices(facts(), affected, originals, (id) => app.requestById(id))) {
      const tab = tabsStore.find(tabId)
      if (tab) tab.remoteNotice = notice
    }
  }

  // ---- account --------------------------------------------------------------

  async saveConfig(config: CloudConfig): Promise<CloudConfig> {
    const saved = await api().setCloudConfig(config)
    this.config = saved
    await this.refreshSession()
    return saved
  }

  async startSignIn(): Promise<void> {
    this.signIn = { phase: 'starting', info: null, message: null, expiresAt: null }
    try {
      const info = await api().startCloudSignIn()
      // The result may already have arrived as an event while the call was in flight.
      if (this.signIn.phase === 'starting') this.signIn = { phase: 'waiting', info, message: null, expiresAt: nowSec() + info.expiresInSec }
    } catch (e) {
      this.signIn = { phase: 'error', info: null, message: errorInfo(e).message, expiresAt: null }
    }
  }

  async cancelSignIn(): Promise<void> {
    try {
      await api().cancelCloudSignIn()
    } catch {
      /* the flow is over either way */
    }
    if (this.signIn.phase === 'waiting' || this.signIn.phase === 'starting') this.signIn = { ...idleSignIn(), phase: 'cancelled' }
  }

  #signInResult(result: 'approved' | 'expired' | 'denied' | 'cancelled' | 'error', message: string | null): void {
    if (result === 'approved') {
      this.signIn = { ...this.signIn, phase: 'approved', message: null }
      void this.loadRemotes()
      if (!ui.cloudOpen) toast.success('Signed in to Slinger Cloud')
    } else this.signIn = { phase: result, info: null, message, expiresAt: null }
  }

  resetSignIn(): void {
    this.signIn = idleSignIn()
  }

  async signOut(): Promise<void> {
    this.#quiet = true
    try {
      await api().signOutCloud()
      await this.refreshSession()
      this.signIn = idleSignIn()
      this.remotes = []
    } catch (e) {
      toast.error('Sign out failed', errorInfo(e).message)
    } finally {
      this.#quiet = false
    }
  }

  async loadRemotes(): Promise<void> {
    this.remotesLoading = true
    this.remotesError = null
    try {
      this.remotes = await api().listRemoteWorkspaces()
    } catch (e) {
      this.remotes = []
      this.remotesError = errorInfo(e).message
    } finally {
      this.remotesLoading = false
    }
  }

  preview(remoteId: string): Promise<RemoteWorkspacePreview> {
    return api().previewRemoteWorkspace(remoteId)
  }

  // ---- per-workspace sync ----------------------------------------------------

  #store(status: SyncStatus): SyncStatus {
    this.statuses[status.workspaceId] = status
    return status
  }

  async #busy<T>(workspaceId: string, what: string, fn: () => Promise<T>): Promise<T> {
    this.busy[workspaceId] = what
    try {
      return await fn()
    } finally {
      this.busy[workspaceId] = undefined
    }
  }

  /** Runs a sync cycle. Failures become a toast with a Retry action; the status reflects network trouble. */
  async syncNow(workspaceId: string): Promise<void> {
    try {
      this.#store(await this.#busy(workspaceId, 'sync', () => api().syncNow(workspaceId)))
    } catch (e) {
      toast.push('error', 'Sync failed', errorInfo(e).message, 15000, { label: 'Retry', run: () => void this.syncNow(workspaceId) })
    }
  }

  async setAutoSync(workspaceId: string, enabled: boolean): Promise<void> {
    try {
      this.#store(await api().setAutoSync(workspaceId, enabled))
    } catch (e) {
      toast.error('Could not change auto sync', errorInfo(e).message)
    }
  }

  /** Throws (the flow dialogs show the error inline). */
  async publish(workspaceId: string): Promise<SyncStatus> {
    const status = this.#store(await this.#busy(workspaceId, 'publish', () => api().publishWorkspace(workspaceId)))
    void this.#refreshRemotes()
    return status
  }

  /** Keeps the "Your cloud workspaces" list truthful after link/publish/unlink (only when it was loaded). */
  #refreshRemotes(): Promise<void> {
    return this.signedIn && this.remotes.length > 0 ? this.loadRemotes() : Promise.resolve()
  }

  /** Throws. On success the returned workspace exists locally (refresh the list yourself). */
  async link(input: LinkRemoteWorkspaceInput): Promise<{ workspace: Workspace; status: SyncStatus }> {
    const res = await api().linkRemoteWorkspace(input)
    this.#store(res.status)
    void this.#refreshRemotes()
    return res
  }

  async unlink(workspaceId: string): Promise<boolean> {
    try {
      await api().unlinkWorkspace(workspaceId)
      this.statuses[workspaceId] = await api().getSyncStatus(workspaceId)
      if (workspaceId === app.workspaceId) this.conflicts = []
      void this.#refreshRemotes()
      return true
    } catch (e) {
      toast.error('Could not unlink', errorInfo(e).message)
      return false
    }
  }

  async discardPending(workspaceId: string): Promise<boolean> {
    try {
      this.#store(await this.#busy(workspaceId, 'discard', () => api().discardPendingChanges(workspaceId)))
      if (workspaceId === app.workspaceId) {
        await app.reloadCollections()
        await app.reloadEnvironments()
        this.conflicts = []
      }
      return true
    } catch (e) {
      toast.error('Could not discard local changes', errorInfo(e).message)
      return false
    }
  }

  // ---- conflicts ---------------------------------------------------------------

  /** The conflict center is open, so the "N sync conflicts" toast is redundant. */
  clearConflictToast(): void {
    if (this.#conflictToast !== null) toast.dismiss(this.#conflictToast)
    this.#conflictToast = null
  }

  async openConflicts(workspaceId: string): Promise<void> {
    if (workspaceId !== app.workspaceId) await app.selectWorkspace(workspaceId)
    ui.conflictsOpen = true
  }

  async loadConflicts(includeResolved = false): Promise<void> {
    const ws = app.workspaceId
    if (!ws) return
    this.conflictsLoading = true
    try {
      const list = await api().listSyncConflicts(ws, includeResolved)
      if (ws === app.workspaceId) this.conflicts = list
    } catch (e) {
      toast.error('Could not load conflicts', errorInfo(e).message)
    } finally {
      this.conflictsLoading = false
    }
  }

  /** Throws (the conflict center shows the error on the conflict). Refreshes the list and local data. */
  async resolve(input: ResolveSyncConflictInput): Promise<void> {
    const ws = app.workspaceId
    const status = await api().resolveSyncConflict(input)
    this.#store(status)
    if (ws && ws === app.workspaceId) {
      this.conflicts = this.conflicts.filter((c) => c.id !== input.conflictId)
      await this.loadConflicts()
    }
  }
}

export const sync = new SyncStore()
