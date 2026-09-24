/**
 * Mock of the cloud-account + sync half of SlingerIpcApi (docs/SYNC_DESIGN.md section 11).
 *
 * It simulates BOTH the cloud server (remote workspaces, roles, versions, tombstones) and the desktop
 * engine (dirty detection against the last-synced payload, pull-then-push cycles, 3-way merge per field
 * group, conflicts of every kind, read-only workspaces, offline, auth expiry, protocol gate) on top of the
 * in-memory MockState, so every UI state is reachable in a plain browser. Controls for scripting those
 * states live on `window.__slingerMock.cloud`.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import {
  type ApiRequest,
  type CloudConfig,
  type CloudRole,
  type CloudSession,
  type CloudUser,
  type RemoteWorkspace,
  type SyncConflict,
  type SyncConflictGroup,
  type SyncConflictKind,
  type SyncEntityType,
  type SyncEvent,
  type SyncProgress,
  type SyncResolution,
  type SyncState,
  type SyncStatus,
  type Workspace,
} from '../../../shared/types'
import {
  addFolder,
  addRequest,
  addVariable,
  removeCollection,
  removeEnvironment,
  type MockState,
} from './store'
import {
  GROUP_FIELDS,
  GROUP_LABEL,
  canonical,
  contentDetail,
  groupValue,
  keyOf,
  labelOf,
  localKeys,
  merge,
  splitKey,
  toWire,
  type GroupName,
  type Wire,
} from './syncWire'
import { clone, fail, nowSec, sleep, uuid } from './util'

type SyncApi = Pick<
  SlingerIpcApi,
  | 'getCloudConfig'
  | 'setCloudConfig'
  | 'getCloudSession'
  | 'startCloudSignIn'
  | 'cancelCloudSignIn'
  | 'signOutCloud'
  | 'listRemoteWorkspaces'
  | 'previewRemoteWorkspace'
  | 'getSyncStatus'
  | 'listSyncStatuses'
  | 'syncNow'
  | 'setAutoSync'
  | 'publishWorkspace'
  | 'linkRemoteWorkspace'
  | 'unlinkWorkspace'
  | 'listSyncConflicts'
  | 'resolveSyncConflict'
  | 'discardPendingChanges'
  | 'onSyncEvent'
>

export interface CloudOptions {
  /** Approve a pending device sign-in by itself after this many ms (null: only via controls). */
  autoApproveMs?: number | null
  /** Run a sync cycle this many ms after a local edit of an auto-sync workspace (0: never automatically). */
  autoCycleMs?: number
  /** Simulated duration of one push/pull step, for visible progress. */
  stepMs?: number
}

export const DEFAULT_BASE_URL = 'https://api.slinger.app'
const MAX_NAME = 200
export const ID_IN_USE = "this item's id is already used by another cloud workspace"

interface RemoteEntity {
  version: number
  payload: Wire
}
interface RemoteWs {
  id: string
  name: string
  slug: string
  role: CloudRole
  entities: Map<string, RemoteEntity>
  tombstones: Set<string>
  revoked: boolean
  deleted: boolean
}
interface BaseEntry {
  version: number
  payload: Wire
}
interface ConflictRow {
  id: string
  workspaceId: string
  entityType: SyncEntityType
  entityId: string
  kind: SyncConflictKind
  status: 'open' | 'resolved' | 'auto_resolved'
  label: string
  message: string
  base: Wire | null
  local: Wire | null
  remote: Wire | null
  remoteVersion: number
  groups: GroupName[]
  createdAt: number
  resolvedAt: number | null
  resolution: SyncResolution | null
}
interface Link {
  workspaceId: string
  remoteId: string
  remoteName: string
  role: CloudRole
  autoSync: boolean
  lastSyncedAt: number | null
  base: Map<string, BaseEntry>
  conflicts: ConflictRow[]
  linkState: 'initial' | 'active'
  accessState: 'ok' | 'revoked' | 'remote_deleted'
  lastError: { code: string; message: string } | null
  nextRetryAt: number | null
  progress: SyncProgress | null
  running: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  /** Ids created locally that the "server" holds elsewhere are reported once per key. */
  apiBaseUrl: string
}

export interface MockCloudControls {
  approveSignIn(): void
  denySignIn(): void
  expireSignIn(): void
  /** The server rejected the refresh token: the session ends (signedOut). */
  expireAuth(): void
  setOffline(offline: boolean): void
  setServerProtocol(version: number): void
  setRole(remoteId: string, role: CloudRole): void
  revokeAccess(remoteId: string): void
  deleteRemote(remoteId: string): void
  findRemote(name: string): string | null
  remoteAdd(remoteId: string, type: SyncEntityType, payload: Wire, id?: string): string
  remoteEdit(remoteId: string, type: SyncEntityType, id: string, patch: Wire): void
  remoteDelete(remoteId: string, type: SyncEntityType, id: string): void
  remoteEntities(remoteId: string): Array<{ type: SyncEntityType; id: string; version: number; payload: Wire }>
  /** Adds an open conflict of any kind (e.g. immutable_clash / rejected / duplicate_key) for the UI to show. */
  injectConflict(input: { workspaceId: string; kind: SyncConflictKind; entityType?: SyncEntityType; entityId?: string; label?: string; message?: string }): string
  /** Runs one full cycle without the simulated delays and resolves when it is done. */
  runCycle(workspaceId: string): Promise<SyncStatus>
  /** Signs in, publishes a workspace and creates conflicts of every kind. Returns what was created. */
  scenario(name: 'conflicts' | 'readonly' | 'signedin', workspaceId?: string): Promise<Record<string, string>>
}

const TYPE_ORDER: Record<SyncEntityType, number> = {
  collection: 0,
  environment: 1,
  folder: 2,
  request: 3,
  environment_variable: 4,
  collection_version: 5,
}
const byType = (a: string, b: string) => TYPE_ORDER[splitKey(a).type] - TYPE_ORDER[splitKey(b).type]

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function createSyncApi(
  s: MockState,
  options: CloudOptions = {},
): { api: SyncApi; controls: MockCloudControls; beforeWrite(method: string, args: unknown[]): string | null; afterWrite(workspaceId: string | null): void; reset(): void } {
  const autoCycleMs = options.autoCycleMs ?? 0
  const stepMs = options.stepMs ?? 0
  const autoApproveMs = options.autoApproveMs ?? null
  const listeners = new Set<(e: SyncEvent) => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()

  let config: CloudConfig
  let signedIn: Set<string>
  let user: CloudUser
  let offline: boolean
  let protocol: number
  let signInFlow: { expiresAt: number; timer: ReturnType<typeof setTimeout> | null } | null
  let remotes: Map<string, RemoteWs>
  let links: Map<string, Link>

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
    return t
  }
  const step = () => (stepMs > 0 ? sleep(stepMs) : Promise.resolve())

  // ---- events -------------------------------------------------------------

  function emit(e: SyncEvent) {
    const copy = clone(e)
    for (const l of [...listeners]) {
      try {
        l(copy)
      } catch {
        /* a broken listener must not break the engine */
      }
    }
  }

  // ---- session ------------------------------------------------------------

  const base = () => config.apiBaseUrl
  const isSignedIn = () => signedIn.has(base())

  function session(): CloudSession {
    return {
      apiBaseUrl: base(),
      status: signInFlow ? 'signingIn' : isSignedIn() ? 'signedIn' : 'signedOut',
      user: isSignedIn() ? { ...user } : null,
      offline: offline && isSignedIn(),
    }
  }
  function emitSession() {
    emit({ type: 'auth', session: session() })
    for (const l of links.values()) emitStatus(l)
  }
  const requireSignedIn = () => {
    if (!isSignedIn()) fail('unauthenticated', 'Sign in to Slinger Cloud first.')
  }
  const requireOnline = () => {
    if (offline) fail('network_error', `Could not reach ${base()}. Check your connection and the server URL.`)
  }

  // ---- status -------------------------------------------------------------

  const openConflicts = (l: Link) => l.conflicts.filter((c) => c.status === 'open')

  function dirtyKeys(l: Link): { upserts: string[]; deletes: string[] } {
    const upserts: string[] = []
    const deletes: string[] = []
    const seen = new Set<string>()
    for (const key of localKeys(s, l.workspaceId)) {
      seen.add(key)
      const { type, id } = splitKey(key)
      const b = l.base.get(key)
      if (!b || canonical(b.payload) !== canonical(toWire(s, type, id))) upserts.push(key)
    }
    for (const key of l.base.keys()) if (!seen.has(key)) deletes.push(key)
    return { upserts: upserts.sort(byType), deletes: deletes.sort((a, b) => byType(b, a)) }
  }
  const pendingCount = (l: Link) => {
    const d = dirtyKeys(l)
    return d.upserts.length + d.deletes.length
  }

  function stateOf(l: Link): SyncState {
    if (l.accessState !== 'ok') return 'accessRevoked'
    if (protocol < 2) return 'serverUnsupported'
    if (!isSignedIn()) return 'signedOut'
    if (l.running) return 'syncing'
    if (l.lastError?.code === 'network_error') return 'offline'
    if (l.lastError) return 'error'
    return 'idle'
  }

  function unlinkedStatus(workspaceId: string): SyncStatus {
    return {
      workspaceId,
      linked: false,
      state: 'unlinked',
      apiBaseUrl: null,
      remoteWorkspaceId: null,
      remoteName: null,
      role: null,
      readOnly: false,
      autoSync: false,
      pendingChanges: 0,
      openConflicts: 0,
      initialSyncPending: false,
      lastSyncedAt: null,
      lastError: null,
      nextRetryAt: null,
      progress: null,
    }
  }
  function statusOf(workspaceId: string): SyncStatus {
    const l = links.get(workspaceId)
    if (!l) return unlinkedStatus(workspaceId)
    return {
      workspaceId,
      linked: true,
      state: stateOf(l),
      apiBaseUrl: l.apiBaseUrl,
      remoteWorkspaceId: l.remoteId,
      remoteName: l.remoteName,
      role: l.role,
      readOnly: l.role === 'viewer',
      autoSync: l.autoSync,
      pendingChanges: pendingCount(l),
      openConflicts: openConflicts(l).length,
      initialSyncPending: l.linkState === 'initial',
      lastSyncedAt: l.lastSyncedAt,
      lastError: l.lastError,
      nextRetryAt: l.nextRetryAt,
      progress: l.progress,
    }
  }
  function emitStatus(l: Link) {
    emit({ type: 'status', status: statusOf(l.workspaceId) })
  }

  // ---- applying wire payloads to local rows ------------------------------------

  function bump(row: { updatedAt: number; version: number }) {
    row.updatedAt = nowSec()
    row.version += 1
  }

  function applyWire(workspaceId: string, type: SyncEntityType, id: string, p: Wire): void {
    const now = nowSec()
    const str = (v: unknown) => (v == null ? null : String(v))
    switch (type) {
      case 'collection': {
        const c = s.collections.find((x) => x.id === id)
        if (c) {
          c.name = String(p.name)
          bump(c)
        } else s.collections.push({ id, workspaceId, name: String(p.name), createdAt: now, updatedAt: now, version: 1 })
        return
      }
      case 'environment': {
        const e = s.environments.find((x) => x.id === id)
        if (e) {
          e.name = String(p.name)
          bump(e)
        } else s.environments.push({ id, workspaceId, name: String(p.name), createdAt: now, updatedAt: now, version: 1 })
        return
      }
      case 'folder': {
        const f = s.folders.find((x) => x.id === id)
        if (f) {
          Object.assign(f, { collectionId: String(p.collection_id), parentFolderId: str(p.parent_folder_id), name: String(p.name), sortOrder: Number(p.sort_order ?? 0) })
          bump(f)
        } else
          addFolder(s, { id, workspaceId, collectionId: String(p.collection_id), parentFolderId: str(p.parent_folder_id), name: String(p.name), sortOrder: Number(p.sort_order ?? 0) })
        return
      }
      case 'request': {
        const r = s.requests.find((x) => x.id === id)
        const fields = {
          collectionId: String(p.collection_id),
          folderId: str(p.folder_id),
          name: String(p.name),
          method: String(p.method),
          url: String(p.url),
          documentJson: String(p.document_json ?? '{}'),
          sortOrder: Number(p.sort_order ?? 0),
        }
        if (r) {
          Object.assign(r, fields)
          bump(r)
        } else addRequest(s, { id, workspaceId, ...fields })
        return
      }
      case 'environment_variable': {
        const v = s.variables.find((x) => x.id === id)
        const isSecret = p.is_secret === true
        if (v) {
          v.key = String(p.key)
          if (!isSecret) {
            v.value = String(p.value ?? '')
            v.secretMissing = false
          } else if (!v.isSecret) v.value = '' // plaintext became a secret remotely: keep nothing on screen
          v.isSecret = isSecret
          bump(v)
        } else {
          const row = addVariable(s, String(p.environment_id), String(p.key), isSecret ? '' : String(p.value ?? ''), isSecret)
          row.id = id
          if (isSecret) row.secretMissing = true
        }
        return
      }
      default:
    }
  }

  const foldersUnder = (folderId: string): string[] => {
    const out = new Set<string>([folderId])
    let grew = true
    while (grew) {
      grew = false
      for (const f of s.folders) if (f.parentFolderId && out.has(f.parentFolderId) && !out.has(f.id)) (out.add(f.id), (grew = true))
    }
    return [...out]
  }

  function deleteLocal(type: SyncEntityType, id: string): void {
    switch (type) {
      case 'collection':
        return removeCollection(s, id)
      case 'environment':
        return removeEnvironment(s, id)
      case 'folder': {
        const doomed = new Set(foldersUnder(id))
        s.folders = s.folders.filter((f) => !doomed.has(f.id))
        s.requests = s.requests.filter((r) => !(r.folderId && doomed.has(r.folderId)))
        return
      }
      case 'request':
        s.requests = s.requests.filter((r) => r.id !== id)
        return
      case 'environment_variable':
        s.variables = s.variables.filter((v) => v.id !== id)
        return
      default:
    }
  }

  // ---- conflicts ------------------------------------------------------------

  function pathOf(l: Link, type: SyncEntityType, id: string, fallback: Wire | null): string[] {
    const w = toWire(s, type, id) ?? fallback ?? l.base.get(keyOf(type, id))?.payload ?? null
    const names: string[] = []
    const colName = (cid: unknown) => s.collections.find((c) => c.id === cid)?.name ?? (l.base.get(keyOf('collection', String(cid)))?.payload.name as string | undefined) ?? null
    if (!w) return []
    if (type === 'collection') return [String(w.name)]
    if (type === 'environment') return ['Environments', String(w.name)]
    if (type === 'environment_variable') {
      const env = s.environments.find((e) => e.id === w.environment_id)
      return ['Environments', env?.name ?? '(environment)', String(w.key)]
    }
    const chain: string[] = []
    let parent = type === 'folder' ? (w.parent_folder_id as string | null) : (w.folder_id as string | null)
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const f = s.folders.find((x) => x.id === parent)
      const name = f?.name ?? (l.base.get(keyOf('folder', parent))?.payload.name as string | undefined)
      if (!name) break
      chain.unshift(name)
      parent = f ? f.parentFolderId : ((l.base.get(keyOf('folder', parent))?.payload.parent_folder_id as string | null) ?? null)
    }
    const cn = colName(w.collection_id)
    if (cn) names.push(cn)
    return [...names, ...chain, String(w.name)]
  }

  function allowed(c: ConflictRow): SyncResolution[] {
    switch (c.kind) {
      case 'edit_edit': {
        const out: SyncResolution[] = ['keep_local', 'keep_remote']
        out.push('merge')
        if (c.entityType === 'request') out.push('duplicate')
        return out
      }
      case 'remote_deleted':
      case 'local_deleted':
        return ['keep_local', 'keep_remote']
      case 'immutable_clash':
        return ['keep_remote', 'duplicate']
      case 'rejected':
        return ['keep_remote']
      default:
        return []
    }
  }

  const nameOf = (t: SyncEntityType, id: unknown): string | null => {
    if (typeof id !== 'string') return null
    return t === 'collection' ? (s.collections.find((x) => x.id === id)?.name ?? null) : (s.folders.find((x) => x.id === id)?.name ?? null)
  }

  /** Like the real engine: field groups are only reported for edit/edit conflicts (every group, flagged when conflicting). */
  function groupsOf(c: ConflictRow): SyncConflictGroup[] {
    if (c.kind !== 'edit_edit') return []
    const defs = Object.keys(GROUP_FIELDS[c.entityType] ?? {}) as GroupName[]
    return defs.map((g) => {
      const group: SyncConflictGroup & { baseDetail?: string | null; localDetail?: string | null; remoteDetail?: string | null } = {
        group: g,
        label: GROUP_LABEL[g],
        conflicting: c.groups.includes(g),
        base: groupValue(c.entityType, g, c.base, nameOf),
        local: groupValue(c.entityType, g, c.local, nameOf),
        remote: groupValue(c.entityType, g, c.remote, nameOf),
      }
      if (c.entityType === 'request' && g === 'content') Object.assign(group, { baseDetail: contentDetail(c.base), localDetail: contentDetail(c.local), remoteDetail: contentDetail(c.remote) })
      return group
    })
  }

  function contractConflict(l: Link, c: ConflictRow): SyncConflict {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      entityType: c.entityType,
      entityId: c.entityId,
      kind: c.kind,
      status: c.status,
      label: c.label,
      path: pathOf(l, c.entityType, c.entityId, c.local ?? c.remote ?? c.base),
      message: c.message,
      groups: groupsOf(c),
      allowedResolutions: c.status === 'open' ? allowed(c) : [],
      createdAt: c.createdAt,
      resolvedAt: c.resolvedAt,
      resolution: c.resolution,
    }
  }

  const MESSAGES: Record<SyncConflictKind, string> = {
    edit_edit: 'Changed on this device and in the cloud.',
    remote_deleted: 'Deleted in the cloud, but you have unsynced changes to it.',
    local_deleted: 'You deleted this here, but it was changed in the cloud.',
    duplicate_key: 'Another device added a variable with the same name; yours was renamed.',
    immutable_clash: 'Another device created a version with the same number but different content.',
    rejected: 'The cloud refused this change.',
  }

  function openConflict(l: Link, input: Partial<ConflictRow> & Pick<ConflictRow, 'kind' | 'entityType' | 'entityId'>): ConflictRow {
    const existing = l.conflicts.find((c) => c.status === 'open' && c.entityType === input.entityType && c.entityId === input.entityId)
    const label = input.label ?? labelOf(input.entityType, input.local ?? input.remote ?? input.base ?? null, input.entityId)
    if (existing) {
      Object.assign(existing, { ...input, label, id: existing.id, status: 'open' as const })
      return existing
    }
    const row: ConflictRow = {
      id: uuid(),
      workspaceId: l.workspaceId,
      base: null,
      local: null,
      remote: null,
      remoteVersion: 0,
      groups: [],
      message: MESSAGES[input.kind],
      createdAt: nowSec(),
      resolvedAt: null,
      resolution: null,
      status: input.kind === 'duplicate_key' ? 'auto_resolved' : 'open',
      ...input,
      label,
    }
    l.conflicts.push(row)
    return row
  }

  const isFrozen = (l: Link, key: string) => {
    const { type, id } = splitKey(key)
    return l.conflicts.some((c) => c.status === 'open' && c.entityType === type && c.entityId === id)
  }

  // ---- the cycle ----------------------------------------------------------------

  interface Changes {
    changed: Array<{ entityType: SyncEntityType; entityId: string; change: 'upsert' | 'delete' }>
  }

  function pull(l: Link, r: RemoteWs, ch: Changes): void {
    const upserts = [...r.entities.keys()].sort(byType)
    for (const key of upserts) {
      const ent = r.entities.get(key)!
      const { type, id } = splitKey(key)
      const b = l.base.get(key)
      if (b && ent.version <= b.version) continue
      const local = toWire(s, type, id)
      const open = l.conflicts.find((c) => c.status === 'open' && c.entityType === type && c.entityId === id)
      if (open) {
        // Remote moved again while a conflict is open: refresh it, close it when both sides now agree.
        open.remote = ent.payload
        open.remoteVersion = ent.version
        if (local && canonical(local) === canonical(ent.payload)) {
          open.status = 'auto_resolved'
          open.resolvedAt = nowSec()
          l.base.set(key, { version: ent.version, payload: ent.payload })
        }
        continue
      }
      if (!local && !b) {
        applyWire(l.workspaceId, type, id, ent.payload)
        l.base.set(key, { version: ent.version, payload: ent.payload })
        ch.changed.push({ entityType: type, entityId: id, change: 'upsert' })
      } else if (!local && b) {
        // Local delete pending.
        if (canonical(b.payload) === canonical(ent.payload)) {
          l.base.set(key, { version: ent.version, payload: ent.payload })
          continue
        }
        openConflict(l, { kind: 'local_deleted', entityType: type, entityId: id, base: b.payload, local: null, remote: ent.payload, remoteVersion: ent.version })
        l.base.set(key, { version: ent.version, payload: ent.payload })
      } else if (local && (!b || canonical(local) === canonical(b.payload))) {
        if (canonical(local) !== canonical(ent.payload)) {
          applyWire(l.workspaceId, type, id, ent.payload)
          ch.changed.push({ entityType: type, entityId: id, change: 'upsert' })
        }
        l.base.set(key, { version: ent.version, payload: ent.payload })
      } else if (local) {
        const { merged, conflicting } = merge(type, b?.payload ?? null, local, ent.payload)
        if (canonical(merged) !== canonical(local)) {
          applyWire(l.workspaceId, type, id, merged)
          ch.changed.push({ entityType: type, entityId: id, change: 'upsert' })
        }
        l.base.set(key, { version: ent.version, payload: ent.payload })
        if (conflicting.length > 0) {
          openConflict(l, { kind: 'edit_edit', entityType: type, entityId: id, base: b?.payload ?? null, local: toWire(s, type, id), remote: ent.payload, remoteVersion: ent.version, groups: conflicting })
        }
      }
    }
    // Remote deletions: leaves first so a container survives while a dirty child does.
    const tombs = [...r.tombstones].filter((k) => l.base.has(k)).sort((a, b) => byType(b, a))
    for (const key of tombs) {
      const { type, id } = splitKey(key)
      const b = l.base.get(key)!
      const local = toWire(s, type, id)
      if (!local) {
        l.base.delete(key)
        continue
      }
      const dirty = canonical(local) !== canonical(b.payload)
      const livingChild =
        (type === 'collection' && (s.folders.some((f) => f.collectionId === id) || s.requests.some((q) => q.collectionId === id))) ||
        (type === 'folder' && (s.folders.some((f) => f.parentFolderId === id) || s.requests.some((q) => q.folderId === id))) ||
        (type === 'environment' && s.variables.some((v) => v.environmentId === id))
      if (dirty || livingChild) {
        openConflict(l, { kind: 'remote_deleted', entityType: type, entityId: id, base: b.payload, local, remote: null, remoteVersion: 0 })
        continue
      }
      deleteLocal(type, id)
      l.base.delete(key)
      ch.changed.push({ entityType: type, entityId: id, change: 'delete' })
    }
  }

  async function push(l: Link, r: RemoteWs): Promise<void> {
    const d = dirtyKeys(l)
    const ops = [...d.upserts.map((k) => ({ k, del: false })), ...d.deletes.map((k) => ({ k, del: true }))].filter((o) => !isFrozen(l, o.k))
    let done = 0
    l.progress = { phase: 'push', done: 0, total: ops.length }
    for (const { k, del } of ops) {
      const { type, id } = splitKey(k)
      if (del) {
        r.entities.delete(k)
        r.tombstones.add(k)
        l.base.delete(k)
        if (type === 'collection' || type === 'folder' || type === 'environment') cascadeRemote(r, type, id)
      } else {
        const payload = toWire(s, type, id)!
        const b = l.base.get(k)
        const name = payload.name
        const clash = !b && [...remotes.values()].some((o) => o.id !== r.id && o.entities.has(k))
        if (typeof name === 'string' && name.length > MAX_NAME) {
          openConflict(l, {
            kind: 'rejected', entityType: type, entityId: id, base: b?.payload ?? null, local: payload, remote: b?.payload ?? null,
            message: `Names longer than ${MAX_NAME} characters cannot be synced yet (this one has ${name.length}).`,
          })
        } else if (clash) {
          openConflict(l, { kind: 'rejected', entityType: type, entityId: id, base: null, local: payload, remote: null, message: `Rejected: ${ID_IN_USE}.` })
        } else {
          const cur = r.entities.get(k)
          if (cur && b && cur.version !== b.version) continue // sync_conflict: the next round pulls first
          const version = (cur?.version ?? 0) + 1
          r.entities.set(k, { version, payload })
          r.tombstones.delete(k)
          l.base.set(k, { version, payload })
        }
      }
      done++
      if (done % 5 === 0 || done === ops.length) {
        l.progress = { phase: 'push', done, total: ops.length }
        emitStatus(l)
        await step()
      }
    }
  }

  function cascadeRemote(r: RemoteWs, type: SyncEntityType, id: string) {
    const drop = (k: string) => {
      r.entities.delete(k)
      r.tombstones.add(k)
    }
    for (const [k, e] of [...r.entities]) {
      const p = e.payload
      if (type === 'collection' && p.collection_id === id) drop(k)
      if (type === 'environment' && p.environment_id === id) drop(k)
      if (type === 'folder' && (p.parent_folder_id === id || p.folder_id === id)) drop(k)
    }
  }

  function runCycle(l: Link): Promise<void> {
    if (l.running) return l.running
    const p = (async () => {
      const ch: Changes = { changed: [] }
      const openBefore = openConflicts(l).length
      l.progress = null
      emitStatus(l)
      await step()
      try {
        if (!links.has(l.workspaceId)) return
        if (offline) {
          l.lastError = { code: 'network_error', message: `Could not reach ${l.apiBaseUrl}.` }
          l.nextRetryAt = nowSec() + 5
          if (autoCycleMs > 0 && l.autoSync) l.timer = later(() => void runCycle(l), 5000)
          return
        }
        l.nextRetryAt = null
        if (!isSignedIn() || protocol < 2 || l.accessState !== 'ok') return
        const r = remotes.get(l.remoteId)
        if (!r || r.deleted) {
          l.accessState = 'remote_deleted'
          return
        }
        if (r.revoked) {
          l.accessState = 'revoked'
          return
        }
        l.role = r.role
        l.remoteName = r.name
        l.lastError = null
        l.progress = { phase: 'pull', done: 0, total: null }
        emitStatus(l)
        await step()
        pull(l, r, ch)
        if (l.role !== 'viewer') await push(l, r)
        if (l.linkState === 'initial' && dirtyKeys(l).upserts.filter((k) => !isFrozen(l, k)).length === 0) l.linkState = 'active'
        l.lastSyncedAt = nowSec()
      } finally {
        l.progress = null
        l.running = null
        if (ch.changed.length > 0) emit({ type: 'applied', workspaceId: l.workspaceId, changed: ch.changed.slice(0, 500), truncated: ch.changed.length > 500 })
        const open = openConflicts(l).length
        if (open !== openBefore) emit({ type: 'conflicts', workspaceId: l.workspaceId, open })
        emitStatus(l)
      }
    })()
    l.running = p
    return p
  }

  function scheduleCycle(l: Link) {
    if (autoCycleMs <= 0 || !l.autoSync || l.running || l.accessState !== 'ok') return
    if (l.timer) clearTimeout(l.timer)
    l.timer = later(() => void runCycle(l), autoCycleMs)
  }

  // ---- write guard (called by the mock backend around every mutating IPC call) --------

  function wsOfEnv(id: string) {
    return s.environments.find((e) => e.id === id)?.workspaceId ?? null
  }
  function wsOfCollection(id: string) {
    return s.collections.find((c) => c.id === id)?.workspaceId ?? null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a0 = (args: unknown[]): any => args[0]

  /** Workspace an IPC write targets, or null when the call is not a synced write. Throws read_only for viewers. */
  function beforeWrite(method: string, args: unknown[]): string | null {
    let ws: string | null = null
    switch (method) {
      case 'createCollection':
      case 'createEnvironment':
      case 'ensureDefaultEnvironment':
      case 'importPostmanCollection':
        ws = String(a0(args))
        break
      case 'renameCollection':
      case 'deleteCollection':
        ws = wsOfCollection(String(a0(args)))
        break
      case 'createFolder':
      case 'createRequest':
        ws = String(a0(args).workspaceId)
        break
      case 'renameFolder':
      case 'deleteFolder':
        ws = s.folders.find((f) => f.id === a0(args))?.workspaceId ?? null
        break
      case 'moveFolder':
        ws = s.folders.find((f) => f.id === a0(args).folderId)?.workspaceId ?? null
        break
      case 'updateRequest':
      case 'moveRequest':
        ws = s.requests.find((r) => r.id === a0(args).requestId)?.workspaceId ?? null
        break
      case 'renameRequest':
      case 'deleteRequest':
        ws = s.requests.find((r) => r.id === a0(args))?.workspaceId ?? null
        break
      case 'renameEnvironment':
      case 'deleteEnvironment':
        ws = wsOfEnv(String(a0(args)))
        break
      case 'upsertEnvironmentVariable': {
        const input = a0(args) as { environmentId: string; variableId?: string; key: string; isSecret: boolean }
        ws = wsOfEnv(input.environmentId)
        // Local secret values are never blocked (they never sync): only a value-only edit of an existing secret.
        const v = input.variableId ? s.variables.find((x) => x.id === input.variableId) : undefined
        if (v && v.isSecret && input.isSecret && v.key === input.key) return ws
        break
      }
      case 'deleteEnvironmentVariable':
        ws = wsOfEnv(s.variables.find((v) => v.id === a0(args))?.environmentId ?? '')
        break
      case 'createCollectionVersion':
        ws = wsOfCollection(a0(args).collectionId)
        break
      case 'restoreCollectionVersion':
      case 'deleteCollectionVersion':
        ws = s.versions.find((v) => v.id === a0(args))?.workspaceId ?? null
        break
      case 'deleteWorkspace':
        return null
      default:
        return null
    }
    const l = ws ? links.get(ws) : undefined
    if (l && l.role === 'viewer') fail('read_only', 'This workspace is read-only (viewer access): changes are not allowed.')
    return ws && l ? ws : null
  }

  function afterWrite(workspaceId: string | null): void {
    if (!workspaceId) return
    const l = links.get(workspaceId)
    if (!l) return
    // Like the real engine: no status event for a bare local edit; the next cycle (or the renderer's own read) reports it.
    scheduleCycle(l)
  }

  // ---- remote seed ---------------------------------------------------------------

  function newRemote(name: string, role: CloudRole): RemoteWs {
    const r: RemoteWs = { id: uuid(), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), role, entities: new Map(), tombstones: new Set(), revoked: false, deleted: false }
    remotes.set(r.id, r)
    return r
  }
  function rAdd(r: RemoteWs, type: SyncEntityType, payload: Wire, id = uuid()): string {
    const key = keyOf(type, id)
    const cur = r.entities.get(key)
    r.entities.set(key, { version: (cur?.version ?? 0) + 1, payload })
    r.tombstones.delete(key)
    return id
  }
  const doc = (name: string, method: string, url: string) => JSON.stringify({ name, method, url, headers: [] })

  function seedRemotes() {
    const pay = newRemote('Payments API', 'editor')
    const col = rAdd(pay, 'collection', { name: 'Payments' })
    const auth = rAdd(pay, 'folder', { collection_id: col, parent_folder_id: null, name: 'Auth', sort_order: 0 })
    rAdd(pay, 'request', { collection_id: col, folder_id: auth, name: 'Create token', method: 'POST', url: '{{baseUrl}}/token', document_json: doc('Create token', 'POST', '{{baseUrl}}/token'), sort_order: 0 })
    rAdd(pay, 'request', { collection_id: col, folder_id: null, name: 'List charges', method: 'GET', url: '{{baseUrl}}/charges', document_json: doc('List charges', 'GET', '{{baseUrl}}/charges'), sort_order: 1 })
    const env = rAdd(pay, 'environment', { name: 'Production' })
    rAdd(pay, 'environment_variable', { environment_id: env, key: 'baseUrl', value: 'https://pay.example.test', is_secret: false })
    rAdd(pay, 'environment_variable', { environment_id: env, key: 'apiKey', value: null, is_secret: true })

    const docs = newRemote('Shared Docs', 'viewer')
    const ref = rAdd(docs, 'collection', { name: 'Reference' })
    rAdd(docs, 'request', { collection_id: ref, folder_id: null, name: 'Status', method: 'GET', url: 'https://status.example.test', document_json: doc('Status', 'GET', 'https://status.example.test'), sort_order: 0 })
    rAdd(docs, 'request', { collection_id: ref, folder_id: null, name: 'Changelog', method: 'GET', url: 'https://example.test/changelog', document_json: doc('Changelog', 'GET', 'https://example.test/changelog'), sort_order: 1 })

    newRemote('Empty Team', 'owner')
  }

  function reset() {
    for (const t of timers) clearTimeout(t)
    timers.clear()
    config = { apiBaseUrl: DEFAULT_BASE_URL, deviceName: 'Slinger Desktop' }
    signedIn = new Set()
    user = { id: 'user-1', email: 'ana@example.com', displayName: 'Ana Silva' }
    offline = false
    protocol = 2
    signInFlow = null
    remotes = new Map()
    links = new Map()
    seedRemotes()
  }
  reset()

  const remote = (id: string): RemoteWs => {
    const r = remotes.get(id)
    if (!r || r.deleted) fail('not_found', 'Cloud workspace not found.')
    return r
  }
  const workspace = (id: string): Workspace => {
    const w = s.workspaces.find((x) => x.id === id)
    if (!w) fail('not_found', `Workspace not found: ${id}`)
    return w
  }
  const remoteLinkedTo = (remoteId: string): string | null => [...links.values()].find((l) => l.remoteId === remoteId)?.workspaceId ?? null

  function makeLink(workspaceId: string, r: RemoteWs): Link {
    const l: Link = {
      workspaceId, remoteId: r.id, remoteName: r.name, role: r.role, autoSync: true, lastSyncedAt: null, base: new Map(), conflicts: [],
      linkState: 'initial', accessState: 'ok', lastError: null, nextRetryAt: null, progress: null, running: null, timer: null, apiBaseUrl: base(),
    }
    links.set(workspaceId, l)
    return l
  }

  /** Design 9.2 step 5: an unlinked local environment with the same name as a remote one adopts the remote id. */
  function dedupeEnvironments(l: Link, r: RemoteWs) {
    for (const [k, e] of r.entities) {
      const { type, id } = splitKey(k)
      if (type !== 'environment') continue
      const local = s.environments.find((x) => x.workspaceId === l.workspaceId && x.id !== id && x.name.toLowerCase() === String(e.payload.name).toLowerCase() && !r.entities.has(keyOf('environment', x.id)))
      if (!local) continue
      const oldId = local.id
      local.id = id
      const remoteVars = [...r.entities].filter(([vk, v]) => splitKey(vk).type === 'environment_variable' && v.payload.environment_id === id)
      for (const v of s.variables.filter((x) => x.environmentId === oldId)) {
        v.environmentId = id
        const match = remoteVars.find(([, rv]) => rv.payload.key === v.key)
        if (match) v.id = splitKey(match[0]).id
      }
    }
  }

  // ---- resolve ----------------------------------------------------------------------

  function ensureParentsFromRemote(l: Link, type: SyncEntityType, payload: Wire) {
    const r = remotes.get(l.remoteId)
    if (!r) return
    const need: Array<[SyncEntityType, unknown]> =
      type === 'request' || type === 'folder'
        ? [['collection', payload.collection_id], ['folder', type === 'request' ? payload.folder_id : payload.parent_folder_id]]
        : type === 'environment_variable' ? [['environment', payload.environment_id]] : []
    for (const [t, pid] of need) {
      if (!pid) continue
      const key = keyOf(t, String(pid))
      const ent = r.entities.get(key)
      if (ent && !toWire(s, t, String(pid))) {
        ensureParentsFromRemote(l, t, ent.payload)
        applyWire(l.workspaceId, t, String(pid), ent.payload)
        l.base.set(key, { version: ent.version, payload: ent.payload })
      }
    }
  }

  function close(c: ConflictRow, resolution: SyncResolution | null, status: 'resolved' | 'auto_resolved' = 'resolved') {
    c.status = status
    c.resolution = resolution
    c.resolvedAt = nowSec()
  }

  function resolve(l: Link, c: ConflictRow, resolution: SyncResolution, choices: Record<string, 'local' | 'remote'> | undefined, newVersion: string | undefined): Changes {
    const ch: Changes = { changed: [] }
    const key = keyOf(c.entityType, c.entityId)
    const touchChanged = (change: 'upsert' | 'delete') => ch.changed.push({ entityType: c.entityType, entityId: c.entityId, change })
    if (resolution === 'keep_local') {
      if (c.kind === 'remote_deleted') l.base.delete(key)
      else if (c.remote) l.base.set(key, { version: c.remoteVersion, payload: c.remote })
      close(c, resolution)
      return ch
    }
    if (resolution === 'keep_remote') {
      if (c.kind === 'remote_deleted') {
        deleteLocal(c.entityType, c.entityId)
        l.base.delete(key)
        touchChanged('delete')
      } else if (c.kind === 'rejected') {
        const b = l.base.get(key)
        if (b) applyWire(l.workspaceId, c.entityType, c.entityId, b.payload)
        else deleteLocal(c.entityType, c.entityId)
        touchChanged(b ? 'upsert' : 'delete')
      } else if (c.kind === 'immutable_clash') {
        /* versions are not part of the mock's entity set */
      } else if (c.remote) {
        ensureParentsFromRemote(l, c.entityType, c.remote)
        applyWire(l.workspaceId, c.entityType, c.entityId, c.remote)
        l.base.set(key, { version: c.remoteVersion, payload: c.remote })
        touchChanged('upsert')
      }
      close(c, resolution)
      return ch
    }
    if (resolution === 'merge') {
      const local = toWire(s, c.entityType, c.entityId)
      if (local && c.remote) {
        const merged: Wire = { ...local }
        for (const g of c.groups) for (const f of GROUP_FIELDS[c.entityType]?.[g] ?? []) merged[f] = (choices?.[g] === 'remote' ? c.remote : local)[f] ?? null
        applyWire(l.workspaceId, c.entityType, c.entityId, merged)
        l.base.set(key, { version: c.remoteVersion, payload: c.remote })
        touchChanged('upsert')
      }
      close(c, resolution)
      return ch
    }
    // duplicate
    if (c.kind === 'immutable_clash') {
      if (!newVersion || !SEMVER.test(newVersion)) fail('invalid_input', 'Enter a semantic version such as 1.0.1 for the copy.')
    } else if (c.entityType === 'request' && c.local) {
      const copy = uuid()
      const name = `${String(c.local.name)} (conflict copy)`
      const siblings = s.requests.filter((r) => r.collectionId === c.local!.collection_id && r.folderId === c.local!.folder_id)
      applyWire(l.workspaceId, 'request', copy, { ...c.local, name, document_json: retitle(String(c.local.document_json ?? '{}'), name), sort_order: siblings.length })
      ch.changed.push({ entityType: 'request', entityId: copy, change: 'upsert' })
      if (c.remote) {
        applyWire(l.workspaceId, 'request', c.entityId, c.remote)
        l.base.set(key, { version: c.remoteVersion, payload: c.remote })
        touchChanged('upsert')
      }
    }
    close(c, resolution)
    return ch
  }

  function retitle(documentJson: string, name: string): string {
    try {
      const d = JSON.parse(documentJson) as Record<string, unknown>
      if (d && typeof d === 'object') return JSON.stringify({ ...d, name })
    } catch {
      /* keep as is */
    }
    return documentJson
  }

  // ---- the IPC surface -------------------------------------------------------------

  const api: SyncApi = {
    async getCloudConfig() {
      return { ...config }
    },
    async setCloudConfig(c) {
      let ok = false
      try {
        const p = new URL(c.apiBaseUrl.trim()).protocol
        ok = p === 'http:' || p === 'https:'
      } catch {
        ok = false
      }
      if (!ok) fail('invalid_input', 'API base URL must start with http:// or https://')
      const next = { apiBaseUrl: c.apiBaseUrl.trim().replace(/\/+$/, ''), deviceName: c.deviceName.trim() || 'Slinger Desktop' }
      if (signInFlow) fail('sync_blocked', 'Finish or cancel the sign-in before changing the server.')
      const changedBase = next.apiBaseUrl !== config.apiBaseUrl
      config = next
      if (changedBase) emitSession()
      return { ...config }
    },
    async getCloudSession() {
      return session()
    },
    async startCloudSignIn() {
      requireOnline()
      if (isSignedIn()) fail('sync_blocked', 'Already signed in.')
      if (signInFlow?.timer) clearTimeout(signInFlow.timer)
      const expiresAt = nowSec() + 600
      signInFlow = { expiresAt, timer: null }
      if (autoApproveMs !== null) signInFlow.timer = later(() => controls.approveSignIn(), autoApproveMs)
      emitSession()
      const b = base()
      return { userCode: 'WDJB-MJHT', verificationUri: `${b}/device`, verificationUriComplete: `${b}/device?user_code=WDJB-MJHT`, expiresInSec: 600, intervalSec: 5 }
    },
    async cancelCloudSignIn() {
      if (!signInFlow) return
      if (signInFlow.timer) clearTimeout(signInFlow.timer)
      signInFlow = null
      emit({ type: 'signInResult', result: 'cancelled', message: null })
      emitSession()
    },
    async signOutCloud() {
      signedIn.delete(base())
      emitSession()
    },
    async listRemoteWorkspaces() {
      requireOnline()
      requireSignedIn()
      return [...remotes.values()]
        .filter((r) => !r.deleted && !r.revoked)
        .map<RemoteWorkspace>((r) => ({ id: r.id, name: r.name, slug: r.slug, role: r.role, linkedLocalWorkspaceId: remoteLinkedTo(r.id) }))
    },
    async previewRemoteWorkspace(remoteWorkspaceId) {
      requireOnline()
      requireSignedIn()
      const r = remote(remoteWorkspaceId)
      const count = (t: SyncEntityType) => [...r.entities.keys()].filter((k) => k.startsWith(keyOf(t, ''))).length
      const counts = { collections: count('collection'), folders: count('folder'), requests: count('request'), environments: count('environment'), truncated: false }
      return { id: r.id, name: r.name, role: r.role, remoteEmpty: r.entities.size === 0, linkedLocalWorkspaceId: remoteLinkedTo(r.id), counts }
    },

    async getSyncStatus(workspaceId) {
      return statusOf(workspaceId)
    },
    async listSyncStatuses() {
      return [...links.keys()].map(statusOf)
    },
    async syncNow(workspaceId) {
      const l = links.get(workspaceId)
      if (!l) return statusOf(workspaceId)
      if (l.timer) clearTimeout(l.timer)
      await runCycle(l)
      return statusOf(workspaceId)
    },
    async setAutoSync(workspaceId, enabled) {
      const l = links.get(workspaceId)
      if (!l) fail('sync_blocked', 'This workspace is not linked to the cloud.')
      l.autoSync = enabled
      if (!enabled && l.timer) clearTimeout(l.timer)
      emitStatus(l)
      return statusOf(workspaceId)
    },

    async publishWorkspace(workspaceId) {
      const ws = workspace(workspaceId)
      requireOnline()
      requireSignedIn()
      if (protocol < 2) fail('sync_blocked', 'This server is too old for collection sync (needs protocol version 2). Ask its admin to upgrade.')
      if (links.has(workspaceId)) fail('sync_blocked', 'This workspace is already linked to a cloud workspace.')
      const r = newRemote(ws.name, 'owner')
      const l = makeLink(workspaceId, r)
      emitStatus(l)
      void runCycle(l)
      return statusOf(workspaceId)
    },
    async linkRemoteWorkspace(input) {
      requireOnline()
      requireSignedIn()
      if (protocol < 2) fail('sync_blocked', 'This server is too old for collection sync (needs protocol version 2). Ask its admin to upgrade.')
      const r = remote(input.remoteWorkspaceId)
      if (remoteLinkedTo(r.id)) fail('sync_blocked', 'This cloud workspace is already linked to another workspace on this device.')
      let ws: Workspace
      if (input.localWorkspaceId === null) {
        const now = nowSec()
        ws = { id: uuid(), name: r.name, workspaceType: 'team', createdAt: now, updatedAt: now, version: 1 }
        s.workspaces.push(ws)
      } else {
        ws = workspace(input.localWorkspaceId)
        if (links.has(ws.id)) fail('sync_blocked', 'This workspace is already linked to a cloud workspace.')
        if (r.role === 'viewer' && localKeys(s, ws.id).length > 0) {
          fail('sync_blocked', 'This cloud workspace is read-only for you, so local content cannot be uploaded. Download it into a new workspace instead.')
        }
      }
      const l = makeLink(ws.id, r)
      dedupeEnvironments(l, r)
      emitStatus(l)
      void runCycle(l)
      return { workspace: clone(ws), status: statusOf(ws.id) }
    },
    async unlinkWorkspace(workspaceId) {
      const l = links.get(workspaceId)
      if (!l) return
      if (l.timer) clearTimeout(l.timer)
      links.delete(workspaceId)
      emit({ type: 'status', status: unlinkedStatus(workspaceId) })
      emit({ type: 'conflicts', workspaceId, open: 0 })
    },
    async listSyncConflicts(workspaceId, includeResolved) {
      const l = links.get(workspaceId)
      if (!l) return []
      return l.conflicts.filter((c) => includeResolved || c.status === 'open').sort((a, b) => a.createdAt - b.createdAt).map((c) => contractConflict(l, c))
    },
    async resolveSyncConflict(input) {
      const l = [...links.values()].find((x) => x.conflicts.some((c) => c.id === input.conflictId))
      const c = l?.conflicts.find((x) => x.id === input.conflictId)
      if (!l || !c || c.status !== 'open') fail('not_found', 'That conflict no longer exists.')
      if (!allowed(c).includes(input.resolution)) fail('invalid_input', `"${input.resolution}" is not available for this conflict.`)
      if (input.resolution === 'merge') {
        for (const g of c.groups) if (!input.fieldChoices?.[g]) fail('invalid_input', `Choose local or remote for "${GROUP_LABEL[g]}".`)
      }
      if (l.role === 'viewer' && input.resolution === 'keep_local') fail('read_only', 'This workspace is read-only: local changes cannot be kept.')
      const ch = resolve(l, c, input.resolution, input.fieldChoices as Record<string, 'local' | 'remote'> | undefined, input.newVersion)
      if (ch.changed.length > 0) emit({ type: 'applied', workspaceId: l.workspaceId, changed: ch.changed, truncated: false })
      emit({ type: 'conflicts', workspaceId: l.workspaceId, open: openConflicts(l).length })
      emitStatus(l)
      await runCycle(l)
      return statusOf(l.workspaceId)
    },
    async discardPendingChanges(workspaceId) {
      const l = links.get(workspaceId)
      if (!l) fail('sync_blocked', 'This workspace is not linked to the cloud.')
      const ch: Changes = { changed: [] }
      const d = dirtyKeys(l)
      for (const k of d.upserts) {
        const { type, id } = splitKey(k)
        const b = l.base.get(k)
        if (b) applyWire(l.workspaceId, type, id, b.payload)
        else deleteLocal(type, id)
        ch.changed.push({ entityType: type, entityId: id, change: b ? 'upsert' : 'delete' })
      }
      for (const k of d.deletes) {
        const { type, id } = splitKey(k)
        applyWire(l.workspaceId, type, id, l.base.get(k)!.payload)
        ch.changed.push({ entityType: type, entityId: id, change: 'upsert' })
      }
      for (const c of l.conflicts) if (c.status === 'open') close(c, 'keep_remote')
      if (ch.changed.length > 0) emit({ type: 'applied', workspaceId, changed: ch.changed.slice(0, 500), truncated: ch.changed.length > 500 })
      emit({ type: 'conflicts', workspaceId, open: 0 })
      emitStatus(l)
      return statusOf(workspaceId)
    },
    onSyncEvent(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }

  // ---- scripted controls ------------------------------------------------------------

  const controls: MockCloudControls = {
    approveSignIn() {
      if (!signInFlow) return
      if (signInFlow.timer) clearTimeout(signInFlow.timer)
      signInFlow = null
      signedIn.add(base())
      emit({ type: 'signInResult', result: 'approved', message: null })
      emitSession()
    },
    denySignIn() {
      if (!signInFlow) return
      if (signInFlow.timer) clearTimeout(signInFlow.timer)
      signInFlow = null
      emit({ type: 'signInResult', result: 'denied', message: 'The request was denied in the browser.' })
      emitSession()
    },
    expireSignIn() {
      if (!signInFlow) return
      if (signInFlow.timer) clearTimeout(signInFlow.timer)
      signInFlow = null
      emit({ type: 'signInResult', result: 'expired', message: 'The code expired.' })
      emitSession()
    },
    expireAuth() {
      signedIn.delete(base())
      emitSession()
    },
    setOffline(v) {
      offline = v
      emit({ type: 'auth', session: session() })
      for (const l of links.values()) {
        if (!v) {
          if (l.lastError?.code === 'network_error') l.lastError = null
          l.nextRetryAt = null
        }
        emitStatus(l)
      }
    },
    setServerProtocol(v) {
      protocol = v
      for (const l of links.values()) emitStatus(l)
    },
    setRole(remoteId, role) {
      remote(remoteId).role = role
    },
    revokeAccess(remoteId) {
      remote(remoteId).revoked = true
    },
    deleteRemote(remoteId) {
      remote(remoteId).deleted = true
    },
    findRemote(name) {
      return [...remotes.values()].find((r) => r.name === name)?.id ?? null
    },
    remoteAdd(remoteId, type, payload, id) {
      return rAdd(remote(remoteId), type, payload, id)
    },
    remoteEdit(remoteId, type, id, patch) {
      const r = remote(remoteId)
      const key = keyOf(type, id)
      const cur = r.entities.get(key)
      if (!cur) fail('not_found', 'Remote entity not found.')
      r.entities.set(key, { version: cur.version + 1, payload: { ...cur.payload, ...patch } })
    },
    remoteDelete(remoteId, type, id) {
      const r = remote(remoteId)
      r.entities.delete(keyOf(type, id))
      r.tombstones.add(keyOf(type, id))
      if (type === 'collection' || type === 'folder' || type === 'environment') cascadeRemote(r, type, id)
    },
    remoteEntities(remoteId) {
      return [...remote(remoteId).entities].map(([k, e]) => ({ ...splitKey(k), version: e.version, payload: clone(e.payload) }))
    },
    injectConflict(input) {
      const l = links.get(input.workspaceId)
      if (!l) fail('sync_blocked', 'Workspace is not linked.')
      const type = input.entityType ?? (input.kind === 'immutable_clash' ? 'collection_version' : input.kind === 'duplicate_key' ? 'environment_variable' : 'request')
      const entityId = input.entityId ?? uuid()
      const local = type === 'collection_version' ? null : toWire(s, type, entityId)
      const c = openConflict(l, {
        kind: input.kind, entityType: type, entityId, local,
        remote: local, base: local, label: input.label ?? (type === 'collection_version' ? 'Version 1.0.0' : undefined),
        ...(input.message ? { message: input.message } : {}),
      })
      emit({ type: 'conflicts', workspaceId: l.workspaceId, open: openConflicts(l).length })
      emitStatus(l)
      return c.id
    },
    async runCycle(workspaceId) {
      const l = links.get(workspaceId)
      if (!l) return statusOf(workspaceId)
      await runCycle(l)
      return statusOf(workspaceId)
    },
    async scenario(name, workspaceId) {
      const out: Record<string, string> = {}
      signedIn.add(base())
      emitSession()
      if (name === 'signedin') return out
      if (name === 'readonly') {
        const r = remotes.get(controls.findRemote('Shared Docs')!)!
        const res = await api.linkRemoteWorkspace({ remoteWorkspaceId: r.id, localWorkspaceId: null })
        await controls.runCycle(res.workspace.id)
        out.workspaceId = res.workspace.id
        return out
      }
      const ws = workspaceId ?? s.workspaces.find((w) => w.name === 'Personal')?.id ?? s.workspaces[0]!.id
      out.workspaceId = ws
      await api.publishWorkspace(ws)
      await controls.runCycle(ws)
      const l = links.get(ws)!
      const rid = l.remoteId
      const req = (name: string): ApiRequest => s.requests.find((r) => r.workspaceId === ws && r.name === name)!
      const [a, b, c, d] = [req('Get user'), req('Create user'), req('Delete user'), req('Basic auth check')]
      // edit_edit (content): both sides edit the same request differently.
      const edit = (r: ApiRequest, url: string, name?: string) => {
        r.url = url
        if (name) r.name = name
        r.documentJson = JSON.stringify({ ...(JSON.parse(r.documentJson || '{}') as object), name: r.name, url })
        r.version += 1
      }
      edit(a, 'https://mine.example.test/users/{{userId}}')
      controls.remoteEdit(rid, 'request', a.id, { url: 'https://theirs.example.test/users/{{userId}}', document_json: JSON.stringify({ ...(JSON.parse(a.documentJson || '{}') as object), url: 'https://theirs.example.test/users/{{userId}}' }) })
      // edit_edit (name): both rename the collection.
      const col = s.collections.find((x) => x.workspaceId === ws && x.name === 'Demo API')!
      col.name = 'Demo API (mine)'
      col.version += 1
      controls.remoteEdit(rid, 'collection', col.id, { name: 'Demo API (theirs)' })
      // remote_deleted: remote deletes a request that has local edits.
      edit(b, 'https://mine.example.test/users')
      controls.remoteDelete(rid, 'request', b.id)
      // local_deleted: deleted here, edited there.
      s.requests = s.requests.filter((x) => x.id !== c.id)
      controls.remoteEdit(rid, 'request', c.id, { name: 'Delete user (renamed in cloud)' })
      // rejected: a name the server cannot take.
      d.name = 'Basic auth check ' + 'x'.repeat(200)
      d.version += 1
      await controls.runCycle(ws)
      // The rest cannot arise naturally in the mock.
      controls.injectConflict({ workspaceId: ws, kind: 'duplicate_key', entityType: 'environment_variable', label: 'baseUrl', message: 'Another device added "baseUrl" too. Yours was renamed to baseUrl_conflict.' })
      controls.injectConflict({ workspaceId: ws, kind: 'immutable_clash', entityType: 'collection_version', label: 'Demo API v1.0.0', message: 'Another device created version 1.0.0 with different content.' })
      Object.assign(out, { requestEdited: a.id, collectionRenamed: col.id, remoteDeleted: b.id, localDeleted: c.id, rejected: d.id })
      return out
    },
  }

  return { api, controls, beforeWrite, afterWrite, reset }
}
