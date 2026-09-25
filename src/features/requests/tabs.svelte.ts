/**
 * Open request tabs. Each tab owns an editable draft, its saved fingerprint (dirty tracking),
 * the last response and the in-flight run. Saving handles optimistic-concurrency conflicts.
 *
 * A tab can also show a saved example (`tab.example` set): `draft` is then the example's request
 * part, `exampleDraft` its response part, and saving writes the example back into the parent
 * request's document (`responses`), leaving every other example and the request itself as stored.
 */
import type { ApiFolder, ApiRequest, Collection, HttpResponseData } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import {
  assertDocumentFits,
  exampleFingerprint,
  locateExample,
  locatorFor,
  parseExample,
  readExamples,
  serializeExample,
  updateExamples,
  type ExampleLocator,
  type ExampleResponseDraft,
  type ParsedExample,
} from '../../lib/examples'
import type { DocsMode } from '../../lib/description'
import { api, errorInfo, isVersionConflict } from '../../lib/ipc'
import { nextId } from '../../lib/kv'
import { draftFingerprint, newDraft, parseDocument, serializeDraft, type RequestDraft } from '../../lib/request'
import type { ScriptOutput } from '../../lib/scripts'
import type { TabNotice } from '../sync/tabNotices'
import { cancelRun, executeDraft, type ExecuteOutcome } from './execute'

export type RequestSection = 'params' | 'auth' | 'headers' | 'body' | 'scripts' | 'docs' | 'settings' | 'code'
export type ResponseSection = 'pretty' | 'raw' | 'preview' | 'headers' | 'cookies' | 'tests' | 'console'

export interface ResponseView {
  data: HttpResponseData
  /** Wall-clock time measured by the renderer (includes IPC), for fallback display. */
  elapsedMs: number
  receivedAt: number
}

export const serverKeyOf = (r: Pick<ApiRequest, 'name' | 'method' | 'url' | 'documentJson'>) =>
  `${r.name}\u0000${r.method}\u0000${r.url}\u0000${r.documentJson}`

/** Where an example tab's example lives and what it looked like when loaded/saved. */
export interface ExampleBinding extends ExampleLocator {
  /** The stored example object; saving only replaces the fields that were edited. */
  original: unknown
  /** Parse of `original`, the reference for "was this field edited?". */
  baseline: ParsedExample
  requestFromParent: boolean
  responseTime: number | null
  /** Result of the last reconciliation with the stored request. */
  remote: 'same' | 'changed' | 'gone'
}

export type ExampleSection = 'response' | 'body' | 'headers'

/** A collection or folder shown in an overview tab (its documentation plus a summary). */
export interface OverviewTarget {
  kind: 'collection' | 'folder'
  id: string
}

export function overviewEntity(target: OverviewTarget | null): Collection | ApiFolder | undefined {
  if (!target) return undefined
  return target.kind === 'collection' ? app.collections.find((c) => c.id === target.id) : app.folders.find((f) => f.id === target.id)
}

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
  responseView = $state<ResponseSection>('pretty')
  /** Which script editor the Scripts section shows. */
  scriptsView = $state<'prerequest' | 'test'>('prerequest')

  sending = $state(false)
  runId = $state<string | null>(null)
  cancelled = false
  response = $state.raw<ResponseView | null>(null)
  /** Inline error from the last send (unresolved variables, network failure...). */
  error = $state<{ message: string; unresolved: string[] } | null>(null)
  warnings = $state<string[]>([])
  /** Test results and console output of the last send (in memory only; never persisted). */
  scriptOutput = $state.raw<ScriptOutput | null>(null)
  saving = $state(false)
  /** Set when updateRequest reported a version conflict; the UI shows the resolve dialog. */
  conflict = $state<{ serverRequest: ApiRequest | null } | null>(null)
  /** Set by cloud sync when this request changed or was deleted remotely while the tab has unsaved edits. */
  remoteNotice = $state<TabNotice | null>(null)

  /** Set for example tabs (see the file comment). */
  example = $state.raw<ExampleBinding | null>(null)
  exampleDraft = $state<ExampleResponseDraft | null>(null)
  exampleSavedFingerprint = $state('')
  exampleSection = $state<ExampleSection>('response')

  /**
   * Set for collection/folder overview tabs. `overviewDraft` is the edited description (null = unchanged);
   * saving writes it with setCollectionDescription / setFolderDescription.
   */
  overview = $state.raw<OverviewTarget | null>(null)
  overviewDraft = $state<string | null>(null)
  /** Docs view (request Docs section / overview): null = default (rendered preview). */
  docsMode = $state<DocsMode | null>(null)

  dirty = $derived(
    this.overview
      ? this.overviewDraft !== null && this.overviewDraft !== (overviewEntity(this.overview)?.description ?? '')
      : draftFingerprint(this.draft) !== this.savedFingerprint ||
          (this.exampleDraft !== null && exampleFingerprint(this.exampleDraft) !== this.exampleSavedFingerprint),
  )
  title = $derived(
    this.overview
      ? (overviewEntity(this.overview)?.name ?? `Deleted ${this.overview.kind}`)
      : this.exampleDraft
        ? this.exampleDraft.name.trim() || 'Untitled example'
        : this.draft.name || 'Untitled Request',
  )

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
    if (this.example) {
      const found = locateExample(readExamples(request.documentJson), this.example)
      if (found) this.loadExample(request, found.index)
      else this.example = { ...this.example, remote: 'gone' }
      return
    }
    this.requestId = request.id
    this.collectionId = request.collectionId
    this.folderId = request.folderId
    this.baseVersion = request.version
    this.draft = parseDocument(request)
    this.savedFingerprint = draftFingerprint(this.draft)
    this.serverKey = serverKeyOf(request)
    this.remoteNotice = null
  }

  /** Binds this tab to the example at `index` of `request` and loads both halves into the drafts. */
  loadExample(request: ApiRequest, index: number) {
    this.bindExample(request, index)
    const parsed = parseExample(this.example!.original, request)
    this.draft = parsed.request
    this.exampleDraft = parsed.response
    this.savedFingerprint = draftFingerprint(parsed.request)
    this.exampleSavedFingerprint = exampleFingerprint(parsed.response)
    this.remoteNotice = null
  }

  /**
   * Points the binding at the stored example without touching the drafts; the saved fingerprints
   * follow the stored content so unsaved edits stay dirty and nothing else does.
   */
  rebaseExample(request: ApiRequest, index: number) {
    this.bindExample(request, index)
    const b = this.example!.baseline
    this.savedFingerprint = draftFingerprint(b.request)
    this.exampleSavedFingerprint = exampleFingerprint(b.response)
  }

  private bindExample(request: ApiRequest, index: number) {
    const list = readExamples(request.documentJson)
    const original = list[index]
    const baseline = parseExample(original, request)
    this.example = {
      ...locatorFor(list, index),
      original,
      baseline,
      requestFromParent: baseline.requestFromParent,
      responseTime: baseline.responseTime,
      remote: 'same',
    }
    this.requestId = request.id
    this.collectionId = request.collectionId
    this.folderId = request.folderId
    this.baseVersion = request.version
    this.serverKey = serverKeyOf(request)
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
    const existing = this.tabs.find((t) => t.requestId === request.id && !t.example)
    if (existing) {
      this.activeId = existing.id
      return existing
    }
    const tab = new RequestTab({ request })
    this.tabs.push(tab)
    this.activeId = tab.id
    return tab
  }

  /** The open tab showing example `index` of the request, if any. */
  findExample(requestId: string, index: number): RequestTab | null {
    return this.tabs.find((t) => t.example && t.requestId === requestId && t.example.index === index) ?? null
  }

  openExample(request: ApiRequest, index: number): RequestTab {
    const existing = this.findExample(request.id, index)
    if (existing) {
      this.activeId = existing.id
      return existing
    }
    const tab = new RequestTab()
    tab.loadExample(request, index)
    this.tabs.push(tab)
    this.activeId = tab.id
    return tab
  }

  /** Opens (or focuses) the overview tab of a collection or folder. */
  openOverview(target: OverviewTarget): RequestTab {
    const existing = this.tabs.find((t) => t.overview?.kind === target.kind && t.overview.id === target.id)
    if (existing) {
      this.activeId = existing.id
      return existing
    }
    const tab = new RequestTab()
    tab.overview = { ...target }
    const entity = overviewEntity(target)
    tab.collectionId = target.kind === 'collection' ? target.id : ((entity as ApiFolder | undefined)?.collectionId ?? null)
    tab.folderId = target.kind === 'folder' ? target.id : null
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
    const t = this.tabs.find((x) => x.requestId === requestId && !x.example)
    const server = app.requestById(requestId)
    if (!t || !server || !t.dirty) return
    t.draft.name = server.name
    t.baseVersion = server.version
    t.serverKey = serverKeyOf(server)
    t.savedFingerprint = draftFingerprint(parseDocument(server))
  }

  /**
   * This window changed the request's examples (`responses`). A request tab with unsaved edits takes
   * the new list into its draft and is rebased, so its next Save neither conflicts nor brings back the
   * old list; other tabs are reconciled as after any reload.
   */
  afterExamplesWrite(updated: ApiRequest) {
    app.upsertRequest(updated)
    const t = this.tabs.find((x) => x.requestId === updated.id && !x.example)
    if (t?.dirty) {
      t.draft.extras = { ...t.draft.extras, responses: readExamples(updated.documentJson) }
      t.baseVersion = updated.version
      t.serverKey = serverKeyOf(updated)
      t.savedFingerprint = draftFingerprint(parseDocument(updated))
    }
    this.syncWithServer()
  }

  /**
   * Requests replaced by new ones (a re-import replace): clean tabs of an old id are pointed at its successor so
   * the next reconcile (syncWithServer) loads the new content in place. Dirty tabs are left alone; the reconcile
   * detaches them (unsaved work is never discarded). Returns how many tabs now follow a new request.
   */
  followReplaced(idMap: ReadonlyMap<string, string>): number {
    let n = 0
    for (const t of this.tabs) {
      if (!t.requestId || t.example || t.overview || t.dirty) continue
      const next = idMap.get(t.requestId)
      if (!next) continue
      t.requestId = next
      t.baseVersion = -1 // forces a reload from the new request
      t.serverKey = ''
      n++
    }
    return n
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
    const goneExamples: string[] = []
    for (const t of this.tabs) {
      if (t.overview) {
        // Overview of a collection/folder deleted elsewhere: close it unless it holds unsaved docs.
        if (!overviewEntity(t.overview) && !t.dirty) goneExamples.push(t.id)
        continue
      }
      if (!t.requestId) continue
      if (t.example) {
        if (this.syncExampleTab(t) === 'close') goneExamples.push(t.id)
        continue
      }
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
    if (goneExamples.length) this.closeNow(goneExamples)
  }

  /** Re-finds an example tab's example in the stored request. Clean tabs follow it; dirty ones are flagged. */
  private syncExampleTab(t: RequestTab): 'keep' | 'close' {
    const ex = t.example!
    const server = app.requestById(t.requestId)
    if (!server) {
      if (!t.dirty) return 'close'
      t.example = { ...ex, remote: 'gone' }
      return 'keep'
    }
    t.collectionId = server.collectionId
    t.folderId = server.folderId
    if (server.version === t.baseVersion) return 'keep'
    const list = readExamples(server.documentJson)
    const found = locateExample(list, ex)
    if (!found) {
      if (!t.dirty) return 'close'
      t.example = { ...ex, remote: 'gone' }
      return 'keep'
    }
    if (!t.dirty && (found.changed || ex.requestFromParent)) {
      t.loadExample(server, found.index)
      return 'keep'
    }
    if (found.changed) {
      t.example = { ...ex, index: found.index, remote: 'changed' }
      return 'keep'
    }
    // Only other parts of the request changed: follow the example's new position.
    t.example = { ...ex, index: found.index, count: list.length, remote: 'same' }
    t.baseVersion = server.version
    t.serverKey = serverKeyOf(server)
    return 'keep'
  }

  // ---- saving -----------------------------------------------------------

  /** Saves a tab. Returns true on success. Unsaved new tabs need Save As (caller opens the dialog). */
  async save(tab: RequestTab, opts: { overwrite?: boolean } = {}): Promise<boolean> {
    if (tab.overview) return this.saveOverview(tab)
    if (!tab.requestId) return false
    if (tab.example) return this.saveExample(tab, opts)
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
      this.syncWithServer() // example tabs of this request follow their examples
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

  /** Saves an overview tab's edited description (collection/folder documentation is local-only). */
  private async saveOverview(tab: RequestTab): Promise<boolean> {
    const target = tab.overview!
    const text = tab.overviewDraft
    if (text === null) return true
    tab.saving = true
    try {
      const value = text.trim() === '' ? null : text
      if (target.kind === 'collection') app.upsertCollection(await api().setCollectionDescription(target.id, value))
      else app.upsertFolder(await api().setFolderDescription(target.id, value))
      // Keystrokes typed while saving stay unsaved.
      if (tab.overviewDraft === text) tab.overviewDraft = null
      return true
    } catch (e) {
      toast.error('Could not save documentation', errorInfo(e).message)
      return false
    } finally {
      tab.saving = false
    }
  }

  /**
   * Saves an example tab into the parent request's document. The write is based on the latest stored
   * request (updateRequest with its version), so edits to the request or to other examples made
   * meanwhile are kept. It is a conflict only when THIS example changed or vanished since the tab
   * loaded it; `overwrite` then writes it anyway (re-adding it if it was deleted).
   */
  private async saveExample(tab: RequestTab, opts: { overwrite?: boolean }): Promise<boolean> {
    const ex = tab.example!
    const draft = tab.exampleDraft!
    tab.saving = true
    try {
      // Snapshot BEFORE the round trip: keystrokes typed while saving must stay "unsaved".
      const requestFp = draftFingerprint(tab.draft)
      const responseFp = exampleFingerprint(draft)
      const serialized = serializeExample(ex.original, ex.baseline, { response: $state.snapshot(draft), request: $state.snapshot(tab.draft) })
      let server = app.requestById(tab.requestId) ?? (await this.fetchServer(tab))
      for (let attempt = 0; ; attempt++) {
        if (!server) {
          toast.error('Could not save example', 'Its request no longer exists. Use “Try” to keep the request in a new tab.')
          return false
        }
        const list = readExamples(server.documentJson)
        const found = locateExample(list, ex)
        if ((!found || found.changed) && !opts.overwrite) {
          tab.example = { ...ex, remote: found ? 'changed' : 'gone' }
          tab.conflict = { serverRequest: server }
          return false
        }
        const index = found ? found.index : list.length
        const documentJson = updateExamples(server.documentJson, (l) => {
          const next = [...l]
          next[index] = serialized
          return next
        })
        assertDocumentFits(documentJson)
        try {
          const updated = await api().updateRequest({
            requestId: server.id,
            name: server.name,
            method: server.method,
            url: server.url,
            documentJson,
            expectedVersion: server.version,
          })
          tab.rebaseExample(updated, index)
          tab.savedFingerprint = requestFp
          tab.exampleSavedFingerprint = responseFp
          tab.conflict = null
          tab.remoteNotice = null
          this.afterExamplesWrite(updated)
          return true
        } catch (e) {
          // The cached request was stale: retry once on the fresh one (the example checks run again).
          if (attempt === 0 && isVersionConflict(e)) {
            server = await this.fetchServer(tab)
            continue
          }
          throw e
        }
      }
    } catch (e) {
      if (isVersionConflict(e)) tab.conflict = { serverRequest: (await this.fetchServer(tab)) ?? null }
      else toast.error('Could not save example', errorInfo(e).message)
      return false
    } finally {
      tab.saving = false
    }
  }

  /** "Try": sends the example's request in a new, unsaved request tab; the example is not touched. */
  tryExample(tab: RequestTab): RequestTab {
    const parent = app.requestById(tab.requestId)
    const draft: RequestDraft = { ...$state.snapshot(tab.draft), name: parent?.name ?? tab.title, extras: {} }
    const t = this.newTab({ collectionId: tab.collectionId, folderId: tab.folderId, draft })
    void this.send(t)
    return t
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
    if (tab.example) {
      const found = locateExample(readExamples(server.documentJson), tab.example)
      tab.conflict = null
      app.upsertRequest(server)
      if (found) tab.loadExample(server, found.index)
      else {
        toast.info('Example deleted', 'The example no longer exists, so its tab was closed.')
        this.closeNow([tab.id])
      }
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
    if (tab.overview) return null
    if (tab.example) {
      this.tryExample(tab)
      return null
    }
    if (tab.sending || !app.workspaceId) return null
    tab.sending = true
    tab.cancelled = false
    tab.error = null
    tab.warnings = []
    tab.scriptOutput = null
    const outcome = await executeDraft($state.snapshot(tab.draft) as RequestDraft, {
      workspaceId: app.workspaceId,
      requestId: tab.requestId,
      collectionId: tab.collectionId,
      folderId: tab.folderId,
      onRunId: (id) => (tab.runId = id),
      wasCancelled: () => tab.cancelled,
    })
    tab.sending = false
    tab.runId = null
    app.historyTick++
    tab.scriptOutput = outcome.scripts.scriptCount > 0 || outcome.scripts.console.length > 0 ? outcome.scripts : null
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
