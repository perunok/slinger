/**
 * A Postman `description` (a string, or `{content, type}`) -> stored text + type. Shared by the main-process importer
 * (repositories/common.ts) and the renderer (lib/description.ts, the dev mock importer) so all read descriptions alike.
 * The type is kept only for the object form so export can write the same shape back; an unknown type is treated as
 * Markdown. Empty or whitespace-only text reads as no description.
 */
import type { DescriptionType } from './types'

export function descriptionFromPostman(value: unknown): { text: string | null; type: DescriptionType | null } {
  if (typeof value === 'string') return { text: value.trim() === '' ? null : value, type: null }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content : ''
    if (content.trim() === '') return { text: null, type: null }
    return { text: content, type: o.type === 'text/plain' ? 'text/plain' : 'text/markdown' }
  }
  return { text: null, type: null }
}
