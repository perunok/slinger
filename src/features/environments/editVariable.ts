/**
 * Saving a variable's value from the `{{placeholder}}` hover (see components/editor/cm/template.ts): the value is written
 * back to the scope it currently resolves from (the active environment, the tab's collection or the globals), through the
 * same backends as the variable tables, which also refresh the template scope.
 */
import { app } from '../../app/state.svelte'
import { errorInfo } from '../../lib/ipc'
import type { TemplateScope, VariableInfo } from '../../lib/template'
import { collectionBackend, environmentBackend, globalsBackend, type VarBackend } from './varBackends'

export async function saveVariableValue(v: VariableInfo, value: string, scope: TemplateScope): Promise<void> {
  if (!v.id) throw new Error(`"${v.key}" has not been saved yet.`)
  if (v.source === 'local') throw new Error('Script variables (pm.variables) only exist while a request runs.')
  let backend: VarBackend
  let owner: string | null
  if (v.source === 'global') {
    backend = globalsBackend
    owner = app.workspaceId
  } else if (v.source === 'collection') {
    backend = collectionBackend
    owner = scope.collectionId ?? null
  } else {
    backend = environmentBackend
    owner = app.activeEnvironmentId
  }
  if (!owner) throw new Error(`Cannot tell where "${v.key}" is stored.`)
  try {
    // The scope only holds enabled variables, and an edit never changes whether it is secret. For a secret, `value` is
    // always a new one (the editor does not accept an empty value, which would mean "keep the stored secret").
    await backend.upsert(owner, { key: v.key, value, isSecret: v.secret, enabled: true, variableId: v.id })
  } catch (e) {
    throw new Error(errorInfo(e).message)
  }
  backend.changed(owner)
}
