/**
 * The `{{variables}}` a request draft uses, resolved against a scope for display (the right panel's Variables view).
 * Values are previews: secrets are masked, built-ins show their example. Pure, no DOM.
 */
import { templateTexts, type RequestDraft } from './request'
import { BUILTIN_VARIABLES, parseTokens, SECRET_MASK, sourceLabel, tokenStatus, type TemplateScope, type TokenStatus, type VariableInfo, type VariableSource } from './template'

export interface UsedVariable {
  name: string
  status: TokenStatus
  /** What to show as the value: plain value, the secret mask, a built-in's example, or null when undefined. */
  value: string | null
  /** "Environment: Local", "Collection: Payments", "Globals", "Built-in", or null when undefined. */
  source: string | null
}

/** Every distinct name used by the draft's URL, enabled headers, body, and auth fields, in order of first use. */
export function variableNamesUsed(draft: RequestDraft): string[] {
  const seen = new Set<string>()
  for (const text of templateTexts(draft)) for (const tok of parseTokens(text)) seen.add(tok.name)
  return [...seen]
}

export function describeVariable(name: string, scope: TemplateScope): UsedVariable {
  const status = tokenStatus(name, scope)
  const v = scope.variables.get(name)
  if (v) return { name, status, value: v.secret ? SECRET_MASK : (v.value ?? ''), source: sourceLabel(v, scope) }
  if (status === 'builtin') {
    const b = BUILTIN_VARIABLES.find((x) => x.name === name)
    return { name, status, value: b ? `${b.example} (generated on send)` : null, source: 'Built-in' }
  }
  return { name, status, value: null, source: null }
}

export function usedVariables(draft: RequestDraft, scope: TemplateScope): UsedVariable[] {
  return variableNamesUsed(draft).map((n) => describeVariable(n, scope))
}

const SOURCE_ORDER: Record<VariableSource, number> = { local: 0, data: 1, environment: 2, collection: 3, global: 4 }

/** Every variable in scope (the winning value per name), narrowest scope first, then by name. */
export function variablesInScope(scope: TemplateScope): Array<VariableInfo & { label: string; shown: string }> {
  return [...scope.variables.values()]
    .map((v) => ({ ...v, label: sourceLabel(v, scope), shown: v.secret ? SECRET_MASK : (v.value ?? '') }))
    .sort((a, b) => SOURCE_ORDER[a.source ?? 'environment'] - SOURCE_ORDER[b.source ?? 'environment'] || a.key.localeCompare(b.key))
}
