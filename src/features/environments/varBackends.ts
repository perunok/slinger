/**
 * Where a variable table (EnvModel) loads and saves its rows: an environment, a collection's variables or the
 * workspace's globals. One table component and one autosave model serve all three; the backend says which columns
 * exist (Secret, Enabled) and whether the bulk editor saves with one bulk replace.
 */
import type { CollectionVariable, EnvironmentVariable, GlobalVariable, VariableEntryInput } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { api } from '../../lib/ipc'

/** The fields of a stored variable the editor needs, whatever its scope. */
export interface VarRecord {
  id: string
  key: string
  /** null for secrets. */
  value: string | null
  isSecret: boolean
  secretMissing: boolean
  enabled: boolean
}

export interface VarUpsert {
  key: string
  /** '' on an unchanged stored secret keeps it. */
  value: string
  isSecret: boolean
  enabled: boolean
  variableId?: string
}

export interface VarBackend {
  kind: 'environment' | 'collection' | 'globals'
  /** Secret column (environments, globals). */
  secrets: boolean
  /** Enabled column (collection variables, globals). */
  enabledColumn: boolean
  list(ownerId: string): Promise<VarRecord[]>
  upsert(ownerId: string, row: VarUpsert): Promise<VarRecord>
  remove(variableId: string): Promise<void>
  reveal(variableId: string): Promise<string>
  /** Bulk editor: one replace of the whole list (keeps the order of the text). Absent: per-row saves. */
  replace?(ownerId: string, entries: VariableEntryInput[]): Promise<VarRecord[]>
  /** After a successful write: refresh the template scope. */
  changed(ownerId: string): void
}

const fromEnv = (v: EnvironmentVariable): VarRecord => ({ id: v.id, key: v.key, value: v.value, isSecret: v.isSecret, secretMissing: v.isSecret && v.secretMissing, enabled: true })
const fromCollection = (v: CollectionVariable): VarRecord => ({ id: v.id, key: v.key, value: v.value, isSecret: false, secretMissing: false, enabled: v.enabled })
const fromGlobal = (v: GlobalVariable): VarRecord => ({ id: v.id, key: v.key, value: v.value, isSecret: v.isSecret, secretMissing: v.isSecret && v.secretMissing, enabled: v.enabled })

export const environmentBackend: VarBackend = {
  kind: 'environment',
  secrets: true,
  enabledColumn: false,
  list: async (envId) => (await api().listEnvironmentVariables(envId)).map(fromEnv),
  upsert: async (envId, r) =>
    fromEnv(await api().upsertEnvironmentVariable({ environmentId: envId, key: r.key, value: r.value, isSecret: r.isSecret, variableId: r.variableId })),
  remove: (id) => api().deleteEnvironmentVariable(id),
  reveal: (id) => api().revealEnvironmentVariable(id),
  changed: (envId) => {
    if (app.activeEnvironmentId === envId) void app.refreshEnvVariables()
  },
}

export const collectionBackend: VarBackend = {
  kind: 'collection',
  secrets: false,
  enabledColumn: true,
  list: async (collectionId) => (await api().listCollectionVariables(collectionId)).map(fromCollection),
  upsert: async (collectionId, r) =>
    fromCollection(await api().upsertCollectionVariable({ collectionId, key: r.key, value: r.value, enabled: r.enabled, variableId: r.variableId })),
  remove: (id) => api().deleteCollectionVariable(id),
  reveal: async () => '',
  replace: async (collectionId, entries) =>
    (await api().replaceCollectionVariables(collectionId, entries.map((e) => ({ key: e.key, value: e.value, enabled: e.enabled })))).map(fromCollection),
  changed: (collectionId) => void app.reloadCollectionVariables(collectionId),
}

export const globalsBackend: VarBackend = {
  kind: 'globals',
  secrets: true,
  enabledColumn: true,
  list: async (workspaceId) => (await api().listGlobalVariables(workspaceId)).map(fromGlobal),
  upsert: async (workspaceId, r) =>
    fromGlobal(await api().upsertGlobalVariable({ workspaceId, key: r.key, value: r.value, isSecret: r.isSecret, enabled: r.enabled, variableId: r.variableId })),
  remove: (id) => api().deleteGlobalVariable(id),
  reveal: (id) => api().revealGlobalVariable(id),
  replace: async (workspaceId, entries) => (await api().replaceGlobalVariables(workspaceId, entries)).map(fromGlobal),
  changed: () => void app.reloadGlobals(),
}
