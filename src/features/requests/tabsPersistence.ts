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
 */
import type { ApiFolder, ApiRequest, Collection } from '../../../shared/types'
import { draftFingerprint, newDraft, type RequestDraft } from '../../lib/request'
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
    example: ExampleBindingSnapshot
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

type PersistedTab = PersistedRequestTab | PersistedExampleTab | PersistedOverviewTab | PersistedScratchTab

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

export function writePersisted(workspaceId: string, state: PersistedTabsState): void {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state))
  } catch {
    /* storage unavailable or full: the tab list just won't survive a restart */
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
const pending = new Map<string, PersistedTabsState>()

/** Schedules a debounced write for `workspaceId`; a later call before it fires replaces the payload. */
export function scheduleSave(workspaceId: string, state: PersistedTabsState, delayMs = 500): void {
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
    const state = pending.get(id)
    pending.delete(id)
    if (state) writePersisted(id, state)
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
      const dirty = {
        example: t.example,
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
    const dirty = { draft: t.draft, savedFingerprint: t.savedFingerprint, baseVersion: t.baseVersion, serverKey: t.serverKey }
    if (byteLength(dirty) > MAX_DRAFT_BYTES) {
      entry.draftTooLarge = true
      entry.title = t.title
    } else entry.dirty = dirty
  }
  return entry
}

// ---------------------------------------------------------------------------
// Restore (storage shape -> instructions for building live tabs)
// ---------------------------------------------------------------------------

export type RestoredTabInit =
  | { kind: 'scratch'; draft: RequestDraft; collectionId: string | null; folderId: string | null; section: RequestSection }
  | { kind: 'overview'; target: OverviewTarget; overviewDraft: string | null }
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
    if (p.kind !== 'overview' && p.draftTooLarge && p.title) lostDraftTitles.push(p.title)
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

    case 'overview': {
      const exists = p.target.kind === 'collection' ? data.collections.some((c) => c.id === p.target.id) : data.folders.some((f) => f.id === p.target.id)
      return exists ? { kind: 'overview', target: p.target, overviewDraft: p.overviewDraft } : null
    }

    case 'request': {
      const server = data.requests.find((r) => r.id === p.requestId)
      if (!server) return null // request deleted (or gone via sync): dropped silently
      return { kind: 'request', requestId: server.id, section: p.section, dirty: p.dirty ?? null }
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
