import { EMPTY_SCOPE, layeredScope, type TemplateScope, type VariableInfo, type VariableTarget } from '../lib/template'

/** One collection's enabled variables, as the template scope sees them. */
export interface CollectionScopeLayer {
  name: string
  vars: VariableInfo[]
}

/**
 * The variable scope used by every TemplateInput / template-aware editor and by the send pipeline:
 * globals < the collection's variables < the active environment (Postman precedence). The app state publishes the
 * layers; `collectionId` follows the active tab, so `scope` is what that tab's `{{}}` resolve against. Sends and
 * the runner use `scopeFor(collectionId)` of their own request instead.
 */
class ScopeStore {
  environmentName = $state<string | null>(null)
  environment = $state.raw<VariableInfo[]>([])
  globals = $state.raw<VariableInfo[]>([])
  collections = $state.raw<ReadonlyMap<string, CollectionScopeLayer>>(new Map())
  /** The collection of the active tab (set by the app shell). */
  collectionId = $state<string | null>(null)

  scope = $derived<TemplateScope>(this.scopeFor(this.collectionId))

  /** Registered by the app shell: opens the matching editor with a row for `name` (default target: environment). */
  createVariable: ((name: string, target?: VariableTarget) => void) | null = null
  /** Registered by the app shell: saves a defined variable's value in the scope it resolves from (the `{{}}` hover). */
  editVariable: ((variable: VariableInfo, value: string, scope: TemplateScope) => Promise<void>) | null = null
  /** Registered by the app shell: why variables cannot be edited now (read-only workspace), or null. */
  editBlocked: (() => string | null) | null = null

  scopeFor(collectionId: string | null | undefined): TemplateScope {
    const col = collectionId ? this.collections.get(collectionId) : undefined
    if (!col && this.environment.length === 0 && this.globals.length === 0 && this.environmentName === null) return EMPTY_SCOPE
    return layeredScope({
      environmentName: this.environmentName,
      environment: this.environment,
      collectionId: col ? collectionId : null,
      collectionName: col?.name ?? null,
      collection: col?.vars,
      globals: this.globals,
    })
  }
}

export const scopeStore = new ScopeStore()

/** The `{{}}` popover actions of an editor whose tokens resolve against `getScope()`: create, edit. */
export function variableActions(getScope: () => TemplateScope) {
  return {
    onCreateVariable: (name: string, target: VariableTarget) => scopeStore.createVariable?.(name, target),
    onEditVariable: (variable: VariableInfo, value: string) => {
      const save = scopeStore.editVariable
      return save ? save(variable, value, getScope()) : Promise.reject(new Error('Variables cannot be edited here.'))
    },
    editBlocked: () => scopeStore.editBlocked?.() ?? null,
  }
}
