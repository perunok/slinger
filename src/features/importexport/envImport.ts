/**
 * Importing variables into an environment by name: create it when missing, otherwise merge into the
 * existing one (never a second environment with the same name, never a duplicate key).
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { EnvironmentVariable } from '../../../shared/types'
import { findEnvByName } from '../environments/envLogic'

export interface ImportVar {
  key: string
  value: string
  secret: boolean
}

/**
 * - `keep`: collection variables. Only keys that do not exist yet are added; existing values are kept
 *   (they may hold tokens set by scripts or edited by the user).
 * - `overwrite`: an environment file. Missing keys are added and existing keys take the file's value and
 *   secret flag. An empty value in the file never clears an existing value (so a secret exported
 *   without its value keeps the one stored here).
 */
export type MergeMode = 'keep' | 'overwrite'

export interface MergePlan {
  add: ImportVar[]
  update: Array<ImportVar & { variableId: string }>
  kept: number
}

/** Last occurrence of a key wins (Postman tolerates duplicates in a file; we must not send them). */
export function dedupeVars(vars: readonly ImportVar[]): ImportVar[] {
  const byKey = new Map<string, ImportVar>()
  for (const v of vars) {
    const key = v.key.trim()
    if (!key) continue
    byKey.delete(key)
    byKey.set(key, { ...v, key })
  }
  return [...byKey.values()]
}

export function planMerge(existing: readonly EnvironmentVariable[], incoming: readonly ImportVar[], mode: MergeMode): MergePlan {
  const plan: MergePlan = { add: [], update: [], kept: 0 }
  for (const v of dedupeVars(incoming)) {
    const ex = existing.find((e) => e.key === v.key)
    if (!ex) plan.add.push(v)
    else if (mode === 'keep' || v.value === '') plan.kept++
    else if (!ex.isSecret && !v.secret && ex.value === v.value) plan.kept++
    else plan.update.push({ ...v, variableId: ex.id })
  }
  return plan
}

export interface EnvImportResult {
  environmentId: string
  name: string
  created: boolean
  added: number
  updated: number
  kept: number
}

type EnvApi = Pick<SlingerIpcApi, 'listEnvironments' | 'createEnvironment' | 'listEnvironmentVariables' | 'upsertEnvironmentVariable'>

export async function importIntoEnvironment(
  api: EnvApi,
  workspaceId: string,
  name: string,
  vars: readonly ImportVar[],
  mode: MergeMode,
): Promise<EnvImportResult> {
  // Fresh list, not app state: the name check must match what the backend will enforce.
  const found = findEnvByName(await api.listEnvironments(workspaceId), name)
  const env = found ?? (await api.createEnvironment(workspaceId, name))
  const plan = planMerge(found ? await api.listEnvironmentVariables(env.id) : [], vars, mode)
  for (const v of plan.add) {
    // A secret exported without its value cannot be created as a secret; keep the key so {{placeholders}} resolve.
    const secret = v.secret && v.value !== ''
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: v.key, value: v.value, isSecret: secret })
  }
  for (const v of plan.update) {
    await api.upsertEnvironmentVariable({ environmentId: env.id, variableId: v.variableId, key: v.key, value: v.value, isSecret: v.secret })
  }
  return { environmentId: env.id, name: env.name, created: !found, added: plan.add.length, updated: plan.update.length, kept: plan.kept }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Toast text, e.g. 'Environment "X" updated: 3 added, 16 kept' or 'Environment "X" created with 19 variables'. */
export function describeEnvImport(r: EnvImportResult): string {
  if (r.created) return `Environment "${r.name}" created with ${plural(r.added, 'variable')}`
  const parts = [`${r.added} added`, ...(r.updated ? [`${r.updated} updated`] : []), `${r.kept} kept`]
  return `Environment "${r.name}" updated: ${parts.join(', ')}`
}
