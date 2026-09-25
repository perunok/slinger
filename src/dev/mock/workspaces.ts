import type { EnvironmentVariable } from '../../../shared/types'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import {
  addCollection,
  addEnvironment,
  addVariable,
  must,
  removeCollection,
  removeEnvironment,
  removeWorkspace,
  touch,
  type MockState,
  type VariableRow,
} from './store'
import { cleanName, cleanScriptsJson, fail, nowSec, setDescription, uuid } from './util'

export const SECRET_MASK = '••••••••'

type WorkspaceApi = Pick<
  SlingerIpcApi,
  | 'listWorkspaces'
  | 'createWorkspace'
  | 'renameWorkspace'
  | 'deleteWorkspace'
  | 'listCollections'
  | 'createCollection'
  | 'renameCollection'
  | 'deleteCollection'
  | 'setCollectionScripts'
  | 'setCollectionDescription'
  | 'listEnvironments'
  | 'ensureDefaultEnvironment'
  | 'createEnvironment'
  | 'renameEnvironment'
  | 'deleteEnvironment'
  | 'listEnvironmentVariables'
  | 'upsertEnvironmentVariable'
  | 'deleteEnvironmentVariable'
  | 'revealEnvironmentVariable'
>

function publicVariable(v: VariableRow): EnvironmentVariable {
  return {
    id: v.id,
    environmentId: v.environmentId,
    key: v.key,
    value: v.isSecret ? null : v.value,
    isSecret: v.isSecret,
    maskedValue: v.isSecret ? SECRET_MASK : null,
    secretMissing: v.isSecret && v.secretMissing === true,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    version: v.version,
  }
}

const isKeepMarker = (value: string): boolean => value === '' || value === SECRET_MASK

/**
 * Secret rule: when editing an existing secret, a value of '' or the mask placeholder means
 * "keep the stored secret" (rename-only flow). Converting secret -> plain has no value to
 * fall back on, so a real value must be provided.
 */
function applyValue(existing: VariableRow, value: string, isSecret: boolean): string {
  if (existing.isSecret && isKeepMarker(value)) {
    if (!isSecret) fail('invalid_input', 'A value is required when turning a secret variable into a plain one')
    return existing.value
  }
  if (!existing.isSecret && isSecret && value === SECRET_MASK) return existing.value
  return value
}

export function createWorkspaceApi(s: MockState): WorkspaceApi {
  const workspace = (id: string) => must(s.workspaces, id, 'Workspace')
  const environment = (id: string) => must(s.environments, id, 'Environment')
  const byCreated = <T extends { createdAt: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.createdAt - b.createdAt)

  return {
    async listWorkspaces() {
      return byCreated(s.workspaces)
    },
    async createWorkspace(name) {
      const now = nowSec()
      const row = {
        id: uuid(),
        name: cleanName(name, 'Workspace'),
        workspaceType: 'personal' as const,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
      s.workspaces.push(row)
      return row
    },
    async renameWorkspace(workspaceId, name) {
      const row = workspace(workspaceId)
      row.name = cleanName(name, 'Workspace')
      return touch(row)
    },
    async deleteWorkspace(workspaceId) {
      workspace(workspaceId)
      removeWorkspace(s, workspaceId)
    },

    async listCollections(workspaceId) {
      workspace(workspaceId)
      return byCreated(s.collections.filter((c) => c.workspaceId === workspaceId))
    },
    async createCollection(workspaceId, name) {
      workspace(workspaceId)
      return addCollection(s, workspaceId, cleanName(name, 'Collection'))
    },
    async renameCollection(collectionId, name) {
      const row = must(s.collections, collectionId, 'Collection')
      row.name = cleanName(name, 'Collection')
      return touch(row)
    },
    async deleteCollection(collectionId) {
      must(s.collections, collectionId, 'Collection')
      removeCollection(s, collectionId)
    },
    async setCollectionScripts(collectionId, scriptsJson) {
      const row = must(s.collections, collectionId, 'Collection')
      row.scriptsJson = cleanScriptsJson(scriptsJson)
      return touch(row)
    },
    async setCollectionDescription(collectionId, description) {
      const row = must(s.collections, collectionId, 'Collection')
      setDescription(row, description)
      return touch(row)
    },

    async listEnvironments(workspaceId) {
      workspace(workspaceId)
      return byCreated(s.environments.filter((e) => e.workspaceId === workspaceId))
    },
    async ensureDefaultEnvironment(workspaceId) {
      workspace(workspaceId)
      const existing = byCreated(s.environments.filter((e) => e.workspaceId === workspaceId))[0]
      return existing ?? addEnvironment(s, workspaceId, 'Default')
    },
    async createEnvironment(workspaceId, name) {
      workspace(workspaceId)
      return addEnvironment(s, workspaceId, cleanName(name, 'Environment'))
    },
    async renameEnvironment(environmentId, name) {
      const row = environment(environmentId)
      row.name = cleanName(name, 'Environment')
      return touch(row)
    },
    async deleteEnvironment(environmentId) {
      environment(environmentId)
      removeEnvironment(s, environmentId)
    },

    async listEnvironmentVariables(environmentId) {
      environment(environmentId)
      return s.variables
        .filter((v) => v.environmentId === environmentId)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(publicVariable)
    },
    async upsertEnvironmentVariable(input) {
      environment(input.environmentId)
      const key = input.key?.trim()
      if (!key) fail('invalid_input', 'Variable key must not be empty')
      const clash = s.variables.find(
        (v) => v.environmentId === input.environmentId && v.key === key && v.id !== input.variableId,
      )
      if (clash) fail('invalid_input', `A variable named "${key}" already exists in this environment`)
      const value = input.value ?? ''
      if (!input.variableId) {
        return publicVariable(addVariable(s, input.environmentId, key, value, input.isSecret))
      }
      const existing = must(s.variables, input.variableId, 'Variable')
      if (existing.environmentId !== input.environmentId) fail('invalid_input', 'Variable belongs to a different environment')
      existing.value = applyValue(existing, value, input.isSecret)
      if (!input.isSecret || !isKeepMarker(value)) existing.secretMissing = false
      existing.key = key
      existing.isSecret = input.isSecret
      return publicVariable(touch(existing))
    },
    async deleteEnvironmentVariable(variableId) {
      must(s.variables, variableId, 'Variable')
      s.variables = s.variables.filter((v) => v.id !== variableId)
    },
    async revealEnvironmentVariable(variableId) {
      return must(s.variables, variableId, 'Variable').value
    },
  }
}
