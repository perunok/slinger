/**
 * Persistence for open request tabs (per workspace), so they survive an app restart.
 *
 * Pure logic only (no DOM except `localStorage`, no Svelte, no dependency on the tab store or `app`):
 * `serializeTabs` turns live tab state into a plain, versioned, size-capped JSON shape; `restoreTabs`
 * turns that shape back into instructions for building tabs, given the workspace's current requests /
 * collections / folders (so a request/example/collection/folder that no longer exists is dropped here,
 * not left for the caller to notice). `tabs.svelte.ts` is the only caller: it feeds `restoreTabs` from
 * `app.requests/collections/folders` and turns each `RestoredTabInit` into a real `RequestTab`.
 *
 * Storage key: `slinger.tabs.<workspaceId>`. A dirty tab's draft is skipped (not the whole tab) when it
 * would exceed `MAX_DRAFT_BYTES`; the tab stays in the list with `draftTooLarge` + a `title`, so the
 * restoring side can toast once about what unsaved text could not be kept. At most `MAX_PERSISTED_TABS`
 * tabs are written, always including whichever was active.
 *
 * A saved request's examples (`draft.extras.responses`) are not part of a dirty request draft's snapshot: they are
 * edited in example tabs (which keep their own draft) and written straight into the stored request, so the restore
 * takes them from the stored request again. Large examples therefore no longer push a draft over the limit.
 *
 * Which unsaved edits a write could NOT keep (too large, storage full) is tracked per workspace (`unpersistedTitles`),
 * so quitting can warn about exactly those.
 */
import type { ApiFolder, ApiRequest, Collection, WorkflowSummary } from '../../../shared/types'
import { draftFingerprint, newDraft, parseDocument, type RequestDraft } from '../../lib/request'
import { exampleFingerprint, locateExample, parseExample, readExamples, type ExampleLocator, type ExampleResponseDraft, type ParsedExample } from '../../lib/examples'
import type { ExampleSection, OverviewTarget, RequestSection } from './tabs.svelte'

export const TABS_STORAGE_VERSION = 1
/** At most this many tabs are written to storage (order kept; the active tab is always included). */
export const MAX_PERSISTED_TABS = 50
/** A single dirty draft above this size is dropped (the tab stays, its unsaved edits do not). */
export const MAX_DRAFT_BYTES = 256 * 1024

export const storageKey = (workspaceId: string): string => `slinger.tabs.${workspaceId}`
const STORAGE_PREFIX = 'slinger.tabs.'

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

interface ExampleBindingSnapshot extends ExampleLocator {
  original: unknown
  baseline: ParsedExample
  requestFromParent: boolean
  responseTime: number | null
  remote: 'same' | 'changed' | 'gone'
}

interface PersistedRequestTab {
  kind: 'request'
  requestId: string
  section: RequestSection
  /** `draft.extras.responses` is left out (see the file comment); entries written before 0.27 may still have it. */
  dirty?: { draft: RequestDraft; savedFingerprint: string; baseVersion: number; serverKey: string }
  draftTooLarge?: true
  title?: string
}

interface PersistedExampleTab {
  kind: 'example'
  requestId: string
  locator: ExampleLocator
  section: RequestSection
  exampleSection: ExampleSection
  dirty?: {
    /** Written before 0.27 only; the restore rebuilds the binding from `locator`. */
    example?: ExampleBindingSnapshot
    draft: RequestDraft
    exampleDraft: ExampleResponseDraft
    savedFingerprint: string
    exampleSavedFingerprint: string
  }
  draftTooLarge?: true
  title?: string
}

interface PersistedOverviewTab {
  kind: 'overview'
  target: OverviewTarget
  overviewDraft: string | null
}

interface PersistedScratchTab {
  kind: 'scratch'
  draft: RequestDraft
  collectionId: string | null
  folderId: string | null
  section: RequestSection
  draftTooLarge?: true
  title?: string
}

/** ADDED (workflows): a workflow tab (the workflow itself is saved as it is edited). */
interface PersistedWorkflowTab {
  kind: 'workflow'
  workflowId: string
}

type PersistedTab = PersistedRequestTab | PersistedExampleTab | PersistedOverviewTab | PersistedScratchTab | PersistedWorkflowTab

export interface PersistedTabsState {
  v: number
  activeIndex: number | null
  tabs: PersistedTab[]
}

// ---------------------------------------------------------------------------
// localStorage access (never throws)
// ---------------------------------------------------------------------------

export function readPersisted(workspaceId: string): PersistedTabsState | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isPersistedTabsState(parsed)) return null
    return parsed
  } catch {
    return null // corrupted JSON: ignore
  }
}

function isPersistedTabsState(v: unknown): v is PersistedTabsState {
  return !!v && typeof v === 'object' && (v as PersistedTabsState).v === TABS_STORAGE_VERSION && Array.isArray((v as PersistedTabsState).tabs)
}

/** Returns false when the state could not be written (storage unavailable or full). */
export function writePersisted(workspaceId: string, state: PersistedTabsState): boolean {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state))
    return true
  } catch {
    return false /* the tab list just won't survive a restart */
  }
}

export function clearPersisted(workspaceId: string): void {
  try {
    localStorage.removeItem(storageKey(workspaceId))
  } catch {
    /* ignore */
  }
}

/** Removes every workspace's persisted tabs (the "restore tabs" setting was turned off). */
export function clearAllPersisted(): void {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_PREFIX))
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

// ---------------------------------------------------------------------------
// Debounced writes
// ---------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const pending = new Map<string, PersistedTabsState | (() => PersistedTabsState)>()
/** Per workspace: titles of the unsaved edits the last write could not keep. */
const unpersisted = new Map<string, string[]>()
let unpersistedListener: (() => void) | null = null

/** Titles of the unsaved edits that the last write of each workspace could not keep (too large, storage full). */
export function unpersistedTitles(): string[] {
  return [...unpersisted.values()].flat()
}
/** Called whenever `unpersistedTitles()` may have changed. */
export function onUnpersistedChange(listener: (() => void) | null): void {
  unpersistedListener = listener
}
/** Forgets what a workspace's last write could not keep (the workspace was deleted, or its tabs are not saved at all). */
export function forgetUnpersisted(workspaceId: string): void {
  if (unpersisted.delete(workspaceId)) unpersistedListener?.()
}

function setUnpersisted(workspaceId: string, titles: string[]): void {
  const before = unpersisted.get(workspaceId) ?? []
  if (titles.length === 0) unpersisted.delete(workspaceId)
  else unpersisted.set(workspaceId, titles)
  if (before.length !== titles.length || before.some((t, i) => t !== titles[i])) unpersistedListener?.()
}

/** What a written state does not keep: drafts dropped as too large, or every unsaved edit when the write failed. */
function lostIn(state: PersistedTabsState, written: boolean): string[] {
  const lost: string[] = []
  for (const t of state.tabs) {
    if ((t.kind === 'request' || t.kind === 'example' || t.kind === 'scratch') && t.draftTooLarge) lost.push(t.title ?? 'Untitled Request')
    else if (written) continue
    else if (t.kind === 'request' && t.dirty) lost.push(t.dirty.draft.name || 'Untitled Request')
    else if (t.kind === 'example' && t.dirty) lost.push(t.dirty.exampleDraft.name || 'Untitled example')
    else if (t.kind === 'scratch' && draftFingerprint(t.draft) !== EMPTY_DRAFT_FINGERPRINT) lost.push(t.draft.name || 'Untitled Request')
    else if (t.kind === 'overview' && t.overviewDraft !== null) lost.push('Documentation')
  }
  return lost
}
const EMPTY_DRAFT_FINGERPRINT = draftFingerprint(newDraft())

/**
 * Schedules a debounced write for `workspaceId`; a later call before it fires replaces the payload. Pass a function to
 * build the state only when the write happens (serializing every draft on each keystroke is what the debounce avoids).
 */
export function scheduleSave(workspaceId: string, state: PersistedTabsState | (() => PersistedTabsState), delayMs = 500): void {
  pending.set(workspaceId, state)
  const existing = timers.get(workspaceId)
  if (existing) clearTimeout(existing)
  timers.set(
    workspaceId,
    setTimeout(() => flushSave(workspaceId), delayMs),
  )
}

/** Writes any pending save(s) immediately (call on `beforeunload`/`pagehide`, or with one workspace id). */
export function flushSave(workspaceId?: string): void {
  const ids = workspaceId ? [workspaceId] : [...pending.keys()]
  for (const id of ids) {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    const entry = pending.get(id)
    pending.delete(id)
    if (!entry) continue
    const state = typeof entry === 'function' ? entry() : entry
    setUnpersisted(id, lostIn(state, writePersisted(id, state)))
  }
}

/** Drops a pending scheduled write without saving it (the tabs are about to be cleared instead). */
export function cancelScheduledSave(workspaceId: string): void {
  const timer = timers.get(workspaceId)
  if (timer) clearTimeout(timer)
  timers.delete(workspaceId)
  pending.delete(workspaceId)
}

// ---------------------------------------------------------------------------
// Serialize (live tabs -> storage shape)
// ---------------------------------------------------------------------------

/** The subset of `RequestTab` this module reads; `RequestTab` itself satisfies this structurally. */
export interface TabLike {
  id: string
  requestId: string | null
  collectionId: string | null
  folderId: string | null
  baseVersion: number
  serverKey: string
  section: RequestSection
  draft: RequestDraft
  savedFingerprint: string
  example: ExampleBindingSnapshot | null
  exampleDraft: ExampleResponseDraft | null
  exampleSavedFingerprint: string
  exampleSection: ExampleSection
  overview: OverviewTarget | null
  overviewDraft: string | null
  workflowId?: string | null
  dirty: boolean
  title: string
}

export function serializeTabs(tabs: readonly TabLike[], activeId: string | null): PersistedTabsState {
  const activeIndex = tabs.findIndex((t) => t.id === activeId)
  let list = tabs
  let keptActiveIndex = activeIndex
  if (list.length > MAX_PERSISTED_TABS) {
    const kept = list.slice(0, MAX_PERSISTED_TABS)
    if (activeIndex >= MAX_PERSISTED_TABS) {
      kept[MAX_PERSISTED_TABS - 1] = list[activeIndex]!
      keptActiveIndex = MAX_PERSISTED_TABS - 1
    }
    list = kept
  }
  const out = list.map((t) => serializeOne(t))
  return { v: TABS_STORAGE_VERSION, activeIndex: keptActiveIndex >= 0 ? keptActiveIndex : null, tabs: out }
}

function serializeOne(t: TabLike): PersistedTab {
  if (t.workflowId) return { kind: 'workflow', workflowId: t.workflowId }
  if (t.overview) return { kind: 'overview', target: t.overview, overviewDraft: t.overviewDraft }

  if (t.example) {
    const entry: PersistedExampleTab = {
      kind: 'example',
      requestId: t.requestId!,
      locator: { index: t.example.index, id: t.example.id, snapshot: t.example.snapshot, name: t.example.name, count: t.example.count },
      section: t.section,
      exampleSection: t.exampleSection,
    }
    if (t.dirty) {
      // The binding itself (`t.example`) is not needed: the restore rebuilds it from `locator`.
      const dirty = {
        draft: t.draft,
        exampleDraft: t.exampleDraft!,
        savedFingerprint: t.savedFingerprint,
        exampleSavedFingerprint: t.exampleSavedFingerprint,
      }
      if (byteLength(dirty) > MAX_DRAFT_BYTES) {
        entry.draftTooLarge = true
        entry.title = t.title
      } else entry.dirty = dirty
    }
    return entry
  }

  if (!t.requestId) {
    // A new, unsaved "scratch" tab: the draft IS the tab, kept regardless of `dirty`.
    if (byteLength(t.draft) > MAX_DRAFT_BYTES) {
      return { kind: 'scratch', draft: newDraft(), collectionId: t.collectionId, folderId: t.folderId, section: t.section, draftTooLarge: true, title: t.title }
    }
    return { kind: 'scratch', draft: t.draft, collectionId: t.collectionId, folderId: t.folderId, section: t.section }
  }

  const entry: PersistedRequestTab = { kind: 'request', requestId: t.requestId, section: t.section }
  if (t.dirty) {
    const dirty = { draft: withoutExamples(t.draft), savedFingerprint: t.savedFingerprint, baseVersion: t.baseVersion, serverKey: t.serverKey }
    if (byteLength(dirty) > MAX_DRAFT_BYTES) {
      entry.draftTooLarge = true
      entry.title = t.title
    } else entry.dirty = dirty
  }
  return entry
}

/** The draft without its saved examples (they are re-read from the stored request on restore). */
function withoutExamples(draft: RequestDraft): RequestDraft {
  if (!draft.extras || !('responses' in draft.extras)) return draft
  const { responses: _examples, ...extras } = draft.extras
  return { ...draft, extras }
}

/**
 * A restored dirty request draft takes the stored request's examples (or none, when it has no `responses`). The keys
 * keep the stored document's order (the dirty check compares serialized documents).
 */
function withStoredExamples(draft: RequestDraft, server: Pick<ApiRequest, 'method' | 'url' | 'documentJson'>): RequestDraft {
  const { responses: _old, ...own } = draft.extras ?? {}
  const stored = parseDocument({ name: '', method: server.method, url: server.url, documentJson: server.documentJson }).extras
  if (!('responses' in stored)) return { ...draft, extras: own }
  const extras: Record<string, unknown> = {}
  for (const k of Object.keys(stored)) {
    if (k === 'responses') extras[k] = stored[k]
    else if (k in own) extras[k] = own[k]
  }
  for (const [k, v] of Object.entries(own)) if (!(k in extras)) extras[k] = v
  return { ...draft, extras }
}

// ---------------------------------------------------------------------------
// Restore (storage shape -> instructions for building live tabs)
// ---------------------------------------------------------------------------

export type RestoredTabInit =
  | { kind: 'scratch'; draft: RequestDraft; collectionId: string | null; folderId: string | null; section: RequestSection }
  | { kind: 'overview'; target: OverviewTarget; overviewDraft: string | null }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'request'; requestId: string; section: RequestSection; dirty: null | { draft: RequestDraft; savedFingerprint: string; baseVersion: number; serverKey: string } }
  | {
      kind: 'example'
      requestId: string
      section: RequestSection
      exampleSection: ExampleSection
      /** Only meaningful when `dirty` is null: where the example currently is. */
      exampleIndex: number
      dirty: null | {
        example: ExampleBindingSnapshot
        draft: RequestDraft
        exampleDraft: ExampleResponseDraft
        savedFingerprint: string
        exampleSavedFingerprint: string
      }
    }

export interface RestoreDataSource {
  requests: Pick<ApiRequest, 'id' | 'collectionId' | 'folderId' | 'version' | 'method' | 'url' | 'documentJson'>[]
  collections: Pick<Collection, 'id'>[]
  folders: Pick<ApiFolder, 'id' | 'collectionId'>[]
  /** The workspace's workflows; null/absent while not loaded yet (workflow tabs are kept, checked later). */
  workflows?: Pick<WorkflowSummary, 'id'>[] | null
}

export interface RestoreResult {
  inits: RestoredTabInit[]
  activeIndex: number | null
  /** Titles of tabs whose unsaved changes were too large to keep (see `MAX_DRAFT_BYTES`); show once. */
  lostDraftTitles: string[]
}

const EMPTY_RESULT: RestoreResult = { inits: [], activeIndex: null, lostDraftTitles: [] }

export function restoreTabs(state: PersistedTabsState | null, data: RestoreDataSource): RestoreResult {
  if (!state) return EMPTY_RESULT
  const inits: RestoredTabInit[] = []
  const lostDraftTitles: string[] = []
  const originalIndexOf: number[] = []

  state.tabs.forEach((p, originalIndex) => {
    if ((p.kind === 'request' || p.kind === 'example' || p.kind === 'scratch') && p.draftTooLarge && p.title) lostDraftTitles.push(p.title)
    const init = restoreOne(p, data)
    if (init) {
      inits.push(init)
      originalIndexOf.push(originalIndex)
    }
  })

  const pos = state.activeIndex == null ? -1 : originalIndexOf.indexOf(state.activeIndex)
  return { inits, activeIndex: pos >= 0 ? pos : null, lostDraftTitles }
}

function restoreOne(p: PersistedTab, data: RestoreDataSource): RestoredTabInit | null {
  switch (p.kind) {
    case 'scratch':
      return { kind: 'scratch', draft: p.draft, collectionId: p.collectionId, folderId: p.folderId, section: p.section }

    case 'workflow':
      return typeof p.workflowId === 'string' && (!data.workflows || data.workflows.some((w) => w.id === p.workflowId))
        ? { kind: 'workflow', workflowId: p.workflowId }
        : null

    case 'overview': {
      const exists = p.target.kind === 'collection' ? data.collections.some((c) => c.id === p.target.id) : data.folders.some((f) => f.id === p.target.id)
      return exists ? { kind: 'overview', target: p.target, overviewDraft: p.overviewDraft } : null
    }

    case 'request': {
      const server = data.requests.find((r) => r.id === p.requestId)
      if (!server) return null // request deleted (or gone via sync): dropped silently
      const dirty = p.dirty ? { ...p.dirty, draft: withStoredExamples(p.dirty.draft, server) } : null
      return { kind: 'request', requestId: server.id, section: p.section, dirty }
    }

    case 'example': {
      const server = data.requests.find((r) => r.id === p.requestId)
      if (!server) return null // the request itself is gone: dropped silently

      if (!p.dirty) {
        const found = locateExample(readExamples(server.documentJson), p.locator)
        if (!found) return null // clean tab, example gone: dropped silently
        return { kind: 'example', requestId: server.id, section: p.section, exampleSection: p.exampleSection, exampleIndex: found.index, dirty: null }
      }

      // Dirty: never silently merge or discard. Re-locate against the OLD snapshot so a real change
      // (or deletion) since we last saw it surfaces as `example.remote`, which the existing conflict
      // dialog already understands - restoring never overwrites that decision.
      const list = readExamples(server.documentJson)
      const found = locateExample(list, p.locator)
      const original: unknown = JSON.parse(p.locator.snapshot || 'null')
      const baseline = parseExample(original, server)
      const example: ExampleBindingSnapshot = {
        index: found ? found.index : p.locator.index,
        id: p.locator.id,
        snapshot: p.locator.snapshot,
        name: p.locator.name,
        count: found ? list.length : p.locator.count,
        original,
        baseline,
        requestFromParent: baseline.requestFromParent,
        responseTime: baseline.responseTime,
        remote: !found ? 'gone' : found.changed ? 'changed' : 'same',
      }
      return {
        kind: 'example',
        requestId: server.id,
        section: p.section,
        exampleSection: p.exampleSection,
        exampleIndex: example.index,
        dirty: {
          example,
          draft: p.dirty.draft,
          exampleDraft: p.dirty.exampleDraft,
          savedFingerprint: draftFingerprint(baseline.request),
          exampleSavedFingerprint: exampleFingerprint(baseline.response),
        },
      }
    }
  }
}
