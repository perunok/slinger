/** The OpenAPI dialog's review of an update plan: groups, per-row choices and counts (pure). */
import type { OpenApiPlannedChange, OpenApiUpdatePlan } from '../../../shared/types'

export type Choice = OpenApiPlannedChange['defaultChoice']
export type GroupId = 'added' | 'changed' | 'edited' | 'removed'

export interface ReviewGroup {
  id: GroupId
  title: string
  /** One line under the title: what the choices do. */
  hint: string
  options: Array<{ value: Choice; label: string }>
  changes: OpenApiPlannedChange[]
}

const GROUPS: Array<Omit<ReviewGroup, 'changes'>> = [
  { id: 'added', title: 'Added', hint: 'Operations the collection has no request for.', options: [{ value: 'apply', label: 'Add' }, { value: 'skip', label: 'Skip' }] },
  { id: 'changed', title: 'Changed', hint: 'Changed in the document, unchanged here since the import.', options: [{ value: 'apply', label: 'Update' }, { value: 'keep', label: 'Keep' }] },
  {
    id: 'edited', title: 'Changed here and in the spec', hint: 'You edited these requests and the document changed them too.',
    options: [{ value: 'keep', label: 'Keep mine' }, { value: 'apply', label: 'Take spec' }],
  },
  { id: 'removed', title: 'Removed', hint: 'No longer in the document.', options: [{ value: 'keep', label: 'Keep' }, { value: 'delete', label: 'Delete' }] },
]

export function groupOf(c: OpenApiPlannedChange): GroupId | null {
  if (c.kind === 'added') return 'added'
  if (c.kind === 'removed') return 'removed'
  if (c.kind === 'changed') return c.editedHere ? 'edited' : 'changed'
  return null
}

/** The non-empty groups in display order (unchanged operations are not listed). */
export function reviewGroups(plan: OpenApiUpdatePlan): ReviewGroup[] {
  return GROUPS.map((g) => ({ ...g, changes: plan.changes.filter((c) => groupOf(c) === g.id) })).filter((g) => g.changes.length > 0)
}

export function defaultChoices(plan: OpenApiUpdatePlan): Record<string, Choice> {
  return Object.fromEntries(plan.changes.filter((c) => groupOf(c)).map((c) => [c.key, c.defaultChoice]))
}

/** What Apply will do with these choices ("2 to add, 1 to update, 1 to delete"). */
export function applySummary(plan: OpenApiUpdatePlan, choices: Readonly<Record<string, Choice>>): string {
  let add = 0
  let update = 0
  let del = 0
  for (const c of plan.changes) {
    const choice = choices[c.key] ?? c.defaultChoice
    if (c.kind === 'added' && choice === 'apply') add++
    else if (c.kind === 'changed' && choice === 'apply') update++
    else if (c.kind === 'removed' && choice === 'delete') del++
  }
  const parts = [add && `${add} to add`, update && `${update} to update`, del && `${del} to delete`].filter(Boolean)
  return parts.length ? parts.join(', ') : 'No request changes'
}

export const unchangedCount = (plan: OpenApiUpdatePlan) => plan.changes.filter((c) => c.kind === 'unchanged').length

/** Short text for a link's source. */
export function sourceLabel(kind: 'url' | 'file' | 'text', value: string | null): string {
  if (kind === 'url') return value ?? 'URL'
  if (kind === 'file') return value ? `File ${value}` : 'A file'
  return 'Pasted text'
}
