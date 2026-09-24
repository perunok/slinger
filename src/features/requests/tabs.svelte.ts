/**
 * Open request tabs. Each tab owns an editable draft, its saved fingerprint (dirty tracking),
 * the last response and the in-flight run. Saving handles optimistic-concurrency conflicts.
 */
import type { ApiRequest, HttpResponseData } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { api, errorInfo, isVersionConflict } from '../../lib/ipc'
import { nextId } from '../../lib/kv'
import { draftFingerprint, newDraft, parseDocument, serializeDraft, type RequestDraft } from '../../lib/request'
import type { TabNotice } from '../sync/tabNotices'
import { cancelRun, executeDraft, type ExecuteOutcome } from './execute'

export type RequestSection = 'params' | 'auth' | 'headers' | 'body' | 'docs' | 'settings' | 'code'

export interface ResponseView {
  data: HttpResponseData
  /** Wall-clock time measured by the renderer (includes IPC), for fallback display. */
  elapsedMs: number
  receivedAt: number
}

export const serverKeyOf = (r: Pick<ApiRequest, 'name' | 'method' | 'url' | 'documentJson'>) =>
  `${r.name}\u0000${r.method}\u0000${r.url}\u0000${r.documentJson}`

export class RequestTab {
  id = nextId('t')
  requestId = $state<string | null>(null)
  collectionId = $state<string | null>(null)
  folderId = $state<string | null>(null)
  baseVersion = $state(0)
  draft = $state<RequestDraft>(newDraft())
  savedFingerprint = $state('')
  /** Server-side content this tab was loaded from (name|method|url|document), to tell moves from real edits. */
  serverKey = $state('')

  section = $state<RequestSection>('params')
  responseView = $state<'pretty' | 'raw' | 'preview' | 'headers' | 'cookies'>('pretty')

  sending = $state(false)
  runId = $state<string | null>(null)
  cancelled = false
  response = $state.raw<ResponseView | null>(null)
  /** Inline error from the last send (unresolved variables, network failure...). */
  error = $state<{ message: string; unresolved: string[] } | null>(null)
  warnings = $state<string[]>([])
  saving = $state(false)
  /** Set when updateRequest reported a version conflict; the UI shows the resolve dialog. */
  conflict = $state<{ serverRequest: ApiRequest | null } | null>(null)
  /** Set by cloud sync when this request changed or was deleted remotely while the tab has unsaved edits. */
  remoteNotice = $state<TabNotice | null>(null)

  dirty = $derived(draftFingerprint(this.draft) !== this.savedFingerprint)
  title = $derived(this.draft.name || 'Untitled Request')

  constructor(init?: { request?: ApiRequest; draft?: RequestDraft; collectionId?: string | null; folderId?: string | null }) {
    if (init?.request) this.loadFrom(init.request)
    else {
      this.draft = init?.draft ?? newDraft()
      this.collectionId = init?.collectionId ?? null
      this.folderId = init?.folderId ?? null
      // A brand-new unsaved tab is "dirty" until saved, but only once it has content.
      this.savedFingerprint = draftFingerprint(newDraft())
    }
  }

  loadFrom(request: ApiRequest) {
    this.requestId = request.id
    this.collectionId = request.collectionId
    this.folderId = request.folderId
    this.baseVersion = request.version
    this.draft = parseDocument(request)
    this.savedFingerprint = draftFingerprint(this.draft)
    this.serverKey = serverKeyOf(request)
    this.remoteNotice = null
  }
}

class TabsStore {
  tabs = $state<RequestTab[]>([])
  activeId = $state<string | null>(null)
  /** Tab awaiting an "unsaved changes" decision. */
  pendingClose = $state<{ ids: string[] } | null>(null)

  active = $derived(this.tabs.find((t) => t.id === this.activeId) ?? null)

  find(id: string | null) {
    return id ? (this.tabs.find((t) => t.id === id) ?? null) : null
  }

  openRequest(request: ApiRequest): RequestTab {
    const existing = this.tabs.find((t) => t.requestId === request.id)
    if (existing) {
      this.activeId = existing.id
      return existing
    }
    const tab = new RequestTab({ request })
    this.tabs.push(tab)
    this.activeId = tab.id
    return tab
  }

  newTab(init?: { collectionId?: string | null; folderId?: string | null; draft?: RequestDraft }): RequestTab {
    const tab = new RequestTab(init)
    this.tabs.push(tab)
    this.activeId = tab.id
    return tab
  }

  activate(id: string) {
    if (this.find(id)) this.activeId = id
  }

  cycle(dir: 1 | -1) {
    if (this.tabs.length < 2) return
    const i = this.tabs.findIndex((t) => t.id === this.activeId)
    this.activeId = this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id
  }

  /** Closes tabs, asking first when any has unsaved changes. */
  requestClose(ids: string[]) {
    const dirty = ids.map((id) => this.find(id)).filter((t): t is RequestTab => !!t && t.dirty)
    if (dirty.length > 0) {
      this.pendingClose = { ids }
      // Bring the first dirty tab forward so the user sees what they are discarding.
      this.activeId = dirty[0].id
    } else this.closeNow(ids)
  }

  closeNow(ids: string[]) {
    for (const id of ids) {
      const t = this.find(id)
      if (t?.runId) void cancelRun(t.runId)
    }
    const set = new Set(ids)
    const index = this.tabs.findIndex((t) => t.id === this.activeId)
    this.tabs = this.tabs.filter((t) => !set.has(t.id))
    if (this.activeId && set.has(this.activeId)) {
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
    }
    this.pendingClose = null
  }

  closeOthers(id: string) {
    this.requestClose(this.tabs.filter((t) => t.id !== id).map((t) => t.id))
  }
  closeAll() {
    this.requestClose(this.tabs.map((t) => t.id))
  }

  /**
   * A sidebar rename bumped the server version and changed the name. For a tab with unsaved edits,
   * adopt the new name/version and keep only the user's other edits dirty (no spurious conflict).
   */
  adoptRename(requestId: string) {
    const t = this.tabs.find((x) => x.requestId === requestId)
    const server = app.requestById(requestId)
    if (!t || !server || !t.dirty) return
    t.draft.name = server.name
    t.baseVersion = server.version
    t.serverKey = serverKeyOf(server)
    t.savedFingerprint = draftFingerprint(parseDocument(server))
  }

  /** Requests deleted elsewhere: drop their tabs without prompting (the data is gone). */
  dropRequests(requestIds: string[]) {
    const ids = this.tabs.filter((t) => t.requestId && requestIds.includes(t.requestId)).map((t) => t.id)
    if (ids.length) this.closeNow(ids)
  }

  /**
   * Reconciles open tabs with freshly loaded requests (after moves, renames, restores...).
   * Location-only changes are adopted silently; content changes reload clean tabs and are left
   * for the conflict dialog on dirty ones. Tabs whose request disappeared are closed.
   */
  syncWithServer() {
    const gone: string[] = []
    for (const t of this.tabs) {
      if (!t.requestId) continue
      const server = app.requestById(t.requestId)
      if (!server) {
        if (t.dirty) {
          // Never discard unsaved work silently: keep the tab, detached, so it can be saved again.
          t.requestId = null
          t.collectionId = null
          t.folderId = null
          t.baseVersion = 0
          t.serverKey = ''
        } else gone.push(t.requestId)
        continue
      }
      if (server.version === t.baseVersion) {
        t.collectionId = server.collectionId
        t.folderId = server.folderId
        continue
      }
      if (serverKeyOf(server) === t.serverKey) {
        t.baseVersion = server.version
        t.collectionId = server.collectionId
        t.folderId = server.folderId
      } else if (!t.dirty) {
        t.loadFrom(server)
      }
    }
    if (gone.length) this.dropRequests(gone)
  }

  // ---- saving -----------------------------------------------------------

  /** Saves a tab. Returns true on success. Unsaved new tabs need Save As (caller opens the dialog). */
  async save(tab: RequestTab, opts: { overwrite?: boolean } = {}): Promise<boolean> {
    if (!tab.requestId) return false
    tab.saving = true
    try {
      const s = serializeDraft(tab.draft)
      // Snapshot BEFORE the round trip: keystrokes typed while saving must stay "unsaved".
      const fingerprint = draftFingerprint(tab.draft)
      const updated = await api().updateRequest({
        requestId: tab.requestId,
        name: s.name,
        method: s.method,
        url: s.url,
        documentJson: s.documentJson,
        expectedVersion: opts.overwrite ? await this.latestVersion(tab) : tab.baseVersion,
      })
      tab.baseVersion = updated.version
      tab.savedFingerprint = fingerprint
      tab.serverKey = serverKeyOf(updated)
      tab.conflict = null
      tab.remoteNotice = null
      app.upsertRequest(updated)
      return true
    } catch (e) {
      if (isVersionConflict(e)) {
        tab.conflict = { serverRequest: (await this.fetchServer(tab)) ?? null }
      } else {
        toast.error('Could not save request', errorInfo(e).message)
      }
      return false
    } finally {
      tab.saving = false
    }
  }

  private async fetchServer(tab: RequestTab): Promise<ApiRequest | undefined> {
    if (!tab.collectionId || !tab.requestId) return undefined
    try {
      return (await api().listRequests(tab.collectionId)).find((r) => r.id === tab.requestId)
    } catch {
      return undefined
    }
  }
  private async latestVersion(tab: RequestTab): Promise<number> {
    return (await this.fetchServer(tab))?.version ?? tab.baseVersion
  }

  /** Conflict resolution: discard local edits and load the stored version. */
  async reloadFromServer(tab: RequestTab) {
    const server = tab.conflict?.serverRequest ?? (await this.fetchServer(tab))
    if (!server) {
      toast.error('Could not reload request', 'The request no longer exists on the server.')
      return
    }
    tab.loadFrom(server)
    tab.conflict = null
    app.upsertRequest(server)
  }

  /** Save As / first save of a new tab: creates a request in the chosen collection. */
  async saveAs(tab: RequestTab, target: { collectionId: string; folderId: string | null; name: string }): Promise<void> {
    if (!app.workspaceId) throw new Error('No workspace selected')
    const s = serializeDraft({ ...tab.draft, name: target.name })
    const fingerprint = draftFingerprint({ ...tab.draft, name: s.name })
    // Throws on failure: the Save As dialog stays open and shows the error.
    const created = await api().createRequest({
      workspaceId: app.workspaceId,
      collectionId: target.collectionId,
      folderId: target.folderId,
      name: s.name,
      method: s.method,
      url: s.url,
      documentJson: s.documentJson,
    })
    app.upsertRequest(created)
    tab.draft.name = created.name
    tab.requestId = created.id
    tab.collectionId = created.collectionId
    tab.folderId = created.folderId
    tab.baseVersion = created.version
    tab.savedFingerprint = fingerprint
    tab.serverKey = serverKeyOf(created)
  }

  // ---- sending ----------------------------------------------------------

  async send(tab: RequestTab): Promise<ExecuteOutcome | null> {
    if (tab.sending || !app.workspaceId) return null
    tab.sending = true
    tab.cancelled = false
    tab.error = null
    tab.warnings = []
    const outcome = await executeDraft(tab.draft, {
      workspaceId: app.workspaceId,
      requestId: tab.requestId,
      onRunId: (id) => (tab.runId = id),
      wasCancelled: () => tab.cancelled,
    })
    tab.sending = false
    tab.runId = null
    app.historyTick++
    if (outcome.ok) {
      tab.response = { data: outcome.response, elapsedMs: outcome.elapsedMs, receivedAt: Date.now() }
      tab.warnings = outcome.warnings
    } else if (outcome.kind !== 'cancelled') {
      tab.error = { message: outcome.error, unresolved: outcome.kind === 'unresolved' ? outcome.unresolved : [] }
    } else {
      tab.error = { message: 'Request cancelled.', unresolved: [] }
    }
    return outcome
  }

  async cancel(tab: RequestTab) {
    if (!tab.runId) return
    tab.cancelled = true
    await cancelRun(tab.runId)
  }
}

export const tabsStore = new TabsStore()
app.onRequestsReloaded = () => tabsStore.syncWithServer()
