/**
 * Browser mock of the persisted collection variables and globals (same rules as electron/repositories/variables.ts):
 * unique live keys per owner, ordered by sortOrder, an empty value on an existing secret keeps it, collection
 * variables are never secret. Secret globals keep their plaintext in the mock state (the real app: OS keychain).
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { CollectionVariableData } from '../../../shared/postmanVariables'
import type { CollectionVariable, GlobalVariable, VariableEntryInput } from '../../../shared/types'
import { must, touch, type MockState, type ScopedVarRow } from './store'
import { fail, nowSec, uuid } from './util'
import { SECRET_MASK } from './workspaces'

type VariablesApi = Pick<
  SlingerIpcApi,
  | 'listCollectionVariables'
  | 'upsertCollectionVariable'
  | 'deleteCollectionVariable'
  | 'reorderCollectionVariables'
  | 'replaceCollectionVariables'
  | 'listGlobalVariables'
  | 'upsertGlobalVariable'
  | 'deleteGlobalVariable'
  | 'reorderGlobalVariables'
  | 'replaceGlobalVariables'
  | 'revealGlobalVariable'
>

const toCollectionVar = (v: ScopedVarRow): CollectionVariable => ({
  id: v.id, collectionId: v.ownerId, key: v.key, value: v.value, enabled: v.enabled, description: v.description, sortOrder: v.sortOrder,
  createdAt: v.createdAt, updatedAt: v.updatedAt, version: v.version,
})
const toGlobal = (v: ScopedVarRow): GlobalVariable => ({
  id: v.id, workspaceId: v.ownerId, key: v.key, value: v.isSecret ? null : v.value, isSecret: v.isSecret, maskedValue: v.isSecret ? SECRET_MASK : null,
  enabled: v.enabled, description: v.description, sortOrder: v.sortOrder, createdAt: v.createdAt, updatedAt: v.updatedAt, version: v.version,
})

function cleanKey(key: string): string {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) fail('invalid_input', 'variable key is required')
  if (k.length > 256) fail('invalid_input', 'variable key must be at most 256 characters')
  return k
}
const cleanDescription = (d: string | null | undefined): string | null => (typeof d === 'string' && d.trim() !== '' ? d : null)

interface Upsert {
  ownerId: string
  workspaceId: string
  key: string
  value: string
  isSecret: boolean
  enabled?: boolean
  description?: string | null
  variableId?: string
  expectedVersion?: number
}

/** Shared row logic for one scope (`rows()` returns the live array of that scope). */
function scope(get: () => ScopedVarRow[], set: (rows: ScopedVarRow[]) => void) {
  const of = (ownerId: string) => get().filter((v) => v.ownerId === ownerId).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  const nextSort = (ownerId: string) => Math.max(-1, ...of(ownerId).map((v) => v.sortOrder)) + 1
  function insert(u: Upsert, sortOrder: number): ScopedVarRow {
    if (u.isSecret && u.value === '') fail('invalid_input', 'a secret variable needs a value')
    const now = nowSec()
    const row: ScopedVarRow = {
      id: uuid(), ownerId: u.ownerId, workspaceId: u.workspaceId, key: u.key, value: u.value, isSecret: u.isSecret, enabled: u.enabled ?? true,
      description: cleanDescription(u.description), sortOrder, createdAt: now, updatedAt: now, version: 1,
    }
    get().push(row)
    return row
  }
  function update(row: ScopedVarRow, u: Upsert): ScopedVarRow {
    const value = u.isSecret && row.isSecret && u.value === '' ? row.value : u.value
    if (u.isSecret && value === '') fail('invalid_input', 'a secret variable needs a value')
    row.key = u.key
    row.value = value
    row.isSecret = u.isSecret
    if (u.enabled !== undefined) row.enabled = u.enabled
    if (u.description !== undefined) row.description = cleanDescription(u.description)
    return touch(row)
  }
  return {
    of,
    upsert(u: Upsert): ScopedVarRow {
      const key = cleanKey(u.key)
      const existing = u.variableId ? must(get(), u.variableId, 'Variable') : of(u.ownerId).find((v) => v.key === key)
      if (existing && existing.ownerId !== u.ownerId) fail('invalid_input', 'the variable belongs to a different owner')
      if (existing && u.expectedVersion !== undefined && existing.version !== u.expectedVersion) {
        fail('version_conflict', 'variable was modified elsewhere; reload and retry', { expectedVersion: u.expectedVersion, currentVersion: existing.version })
      }
      if (of(u.ownerId).some((v) => v.key === key && v.id !== existing?.id)) fail('invalid_input', `a variable named "${key}" already exists`)
      return existing ? update(existing, { ...u, key }) : insert({ ...u, key }, nextSort(u.ownerId))
    },
    remove(id: string) {
      must(get(), id, 'Variable')
      set(get().filter((v) => v.id !== id))
    },
    reorder(ownerId: string, ids: string[]) {
      const live = of(ownerId)
      if (ids.length !== live.length || new Set(ids).size !== ids.length || !ids.every((id) => live.some((v) => v.id === id))) {
        fail('invalid_input', 'reorder needs every live variable exactly once')
      }
      ids.forEach((id, i) => (live.find((v) => v.id === id)!.sortOrder = i))
      return of(ownerId)
    },
    replace(ownerId: string, workspaceId: string, entries: VariableEntryInput[], secrets: boolean) {
      const keys = entries.map((e) => cleanKey(e.key))
      if (new Set(keys).size !== keys.length) fail('invalid_input', 'duplicate variable names')
      if (!secrets && entries.some((e) => e.isSecret)) fail('invalid_input', 'collection variables cannot be secret')
      set(get().filter((v) => v.ownerId !== ownerId || keys.includes(v.key)))
      entries.forEach((e, i) => {
        const u: Upsert = { ownerId, workspaceId, key: keys[i]!, value: e.value, isSecret: e.isSecret === true, enabled: e.enabled !== false, description: e.description ?? null }
        const row = of(ownerId).find((v) => v.key === u.key)
        if (row) {
          const same = row.value === u.value && row.isSecret === u.isSecret && row.enabled === u.enabled && row.description === cleanDescription(u.description)
          if (!same && !(u.isSecret && row.isSecret && u.value === '' && row.enabled === u.enabled)) update(row, u)
          row.sortOrder = i
        } else insert(u, i)
      })
      return of(ownerId)
    },
  }
}

export function createVariablesApi(s: MockState): VariablesApi {
  const cv = scope(() => s.collectionVariables, (rows) => (s.collectionVariables = rows))
  const gv = scope(() => s.globalVariables, (rows) => (s.globalVariables = rows))
  const collection = (id: string) => must(s.collections, id, 'Collection')
  const workspace = (id: string) => must(s.workspaces, id, 'Workspace')
  return {
    async listCollectionVariables(collectionId) {
      collection(collectionId)
      return cv.of(collectionId).map(toCollectionVar)
    },
    async upsertCollectionVariable(input) {
      const c = collection(input.collectionId)
      if (input.isSecret) fail('invalid_input', 'collection variables cannot be secret (use a global or an environment variable)')
      return toCollectionVar(cv.upsert({ ...input, ownerId: c.id, workspaceId: c.workspaceId, isSecret: false }))
    },
    async deleteCollectionVariable(variableId) {
      cv.remove(variableId)
    },
    async reorderCollectionVariables(collectionId, ids) {
      collection(collectionId)
      return cv.reorder(collectionId, ids).map(toCollectionVar)
    },
    async replaceCollectionVariables(collectionId, entries) {
      const c = collection(collectionId)
      return cv.replace(c.id, c.workspaceId, entries, false).map(toCollectionVar)
    },
    async listGlobalVariables(workspaceId) {
      workspace(workspaceId)
      return gv.of(workspaceId).map(toGlobal)
    },
    async upsertGlobalVariable(input) {
      workspace(input.workspaceId)
      return toGlobal(gv.upsert({ ...input, ownerId: input.workspaceId, workspaceId: input.workspaceId }))
    },
    async deleteGlobalVariable(variableId) {
      gv.remove(variableId)
    },
    async reorderGlobalVariables(workspaceId, ids) {
      workspace(workspaceId)
      return gv.reorder(workspaceId, ids).map(toGlobal)
    },
    async replaceGlobalVariables(workspaceId, entries) {
      workspace(workspaceId)
      return gv.replace(workspaceId, workspaceId, entries, true).map(toGlobal)
    },
    async revealGlobalVariable(variableId) {
      return must(s.globalVariables, variableId, 'Variable').value
    },
  }
}

/** Workspace of a variable method's target, for the mock's read-only (viewer) check; null when unknown. */
export function variableMethodWorkspace(s: MockState, method: string, args: unknown[]): string | null | undefined {
  const a0 = args[0] as Record<string, unknown> | string | undefined
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (method) {
    case 'upsertCollectionVariable':
      return s.collections.find((c) => c.id === str((a0 as Record<string, unknown>)?.collectionId))?.workspaceId ?? null
    case 'reorderCollectionVariables':
    case 'replaceCollectionVariables':
      return s.collections.find((c) => c.id === str(a0))?.workspaceId ?? null
    case 'deleteCollectionVariable':
      return s.collectionVariables.find((v) => v.id === str(a0))?.workspaceId ?? null
    case 'upsertGlobalVariable':
      return str((a0 as Record<string, unknown>)?.workspaceId)
    case 'reorderGlobalVariables':
    case 'replaceGlobalVariables':
      return str(a0)
    case 'deleteGlobalVariable':
      return s.globalVariables.find((v) => v.id === str(a0))?.workspaceId ?? null
    default:
      return undefined
  }
}

/** The collection's variables in snapshot / import form (mirrors electron/services/collectionVersions.ts). */
export function collectionVariablesData(s: MockState, collectionId: string): CollectionVariableData[] {
  return s.collectionVariables
    .filter((v) => v.ownerId === collectionId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .map((v) => ({ key: v.key, value: v.value, ...(v.enabled ? {} : { enabled: false }), ...(v.description ? { description: v.description } : {}) }))
}

/** Replaces the collection's variables (import, re-import, version restore). */
export function setCollectionVariables(s: MockState, collectionId: string, workspaceId: string, vars: readonly CollectionVariableData[]): void {
  s.collectionVariables = s.collectionVariables.filter((v) => v.ownerId !== collectionId)
  const now = nowSec()
  vars.forEach((v, i) =>
    s.collectionVariables.push({
      id: uuid(), ownerId: collectionId, workspaceId, key: v.key, value: v.value, isSecret: false, enabled: v.enabled !== false,
      description: v.description ?? null, sortOrder: i, createdAt: now, updatedAt: now, version: 1,
    }),
  )
}
