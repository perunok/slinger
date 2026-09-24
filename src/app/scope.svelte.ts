import { EMPTY_SCOPE, type TemplateScope } from '../lib/template'

/**
 * The variable scope used by every TemplateInput / template-aware editor:
 * the active environment's variables. Set by the environments feature.
 */
class ScopeStore {
  scope = $state.raw<TemplateScope>(EMPTY_SCOPE)
  /** Registered by the app shell: opens the environment editor with `name` pre-filled. */
  createVariable: ((name: string) => void) | null = null
}

export const scopeStore = new ScopeStore()
