/**
 * Session-only script scopes: `pm.globals` (per workspace) and `pm.collectionVariables` (per collection).
 * Slinger has no storage for them in v1, so they live in memory until the app restarts (documented in the
 * user guide). `pm.variables` (local) lives only for one send or one collection run and is not kept here.
 */
import type { ScriptVariables } from '../../../shared/types'

const globals = new Map<string, ScriptVariables>()
const collections = new Map<string, ScriptVariables>()

export const sessionVars = {
  globals: (workspaceId: string): ScriptVariables => globals.get(workspaceId) ?? {},
  setGlobals: (workspaceId: string, vars: ScriptVariables) => void globals.set(workspaceId, vars),
  collection: (collectionId: string | null | undefined): ScriptVariables => (collectionId ? (collections.get(collectionId) ?? {}) : {}),
  setCollection: (collectionId: string | null | undefined, vars: ScriptVariables) => {
    if (collectionId) collections.set(collectionId, vars)
  },
  /** Tests. */
  reset: () => {
    globals.clear()
    collections.clear()
  },
}
