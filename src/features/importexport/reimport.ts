/**
 * Re-importing a Postman collection that already exists in the workspace: which live collections the file
 * matches, and the name an "import as a copy" gets.
 */
import type { Collection } from '../../../shared/types'

export interface ReimportMatch {
  /** 'id': the file's `info._postman_id` equals a collection's id (a Slinger export) or its recorded source id. */
  by: 'id' | 'name'
  collections: Collection[]
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Collections the file matches, or null. A `_postman_id` match wins over a name match (trimmed,
 * case-insensitive), so a renamed collection is still found and an unrelated same-named one is not preferred.
 */
export function findReimportMatches(collections: readonly Collection[], file: { name: string; postmanId: string | null }): ReimportMatch | null {
  const pid = file.postmanId ? norm(file.postmanId) : null
  if (pid) {
    const byId = collections.filter((c) => norm(c.id) === pid || (c.sourcePostmanId && norm(c.sourcePostmanId) === pid))
    if (byId.length) return { by: 'id', collections: byId }
  }
  const name = norm(file.name)
  const byName = collections.filter((c) => norm(c.name) === name)
  return byName.length ? { by: 'name', collections: byName } : null
}

/** "X" when free, otherwise "X (2)", "X (3)"... (first free; names compared trimmed and case-insensitively). */
export function copyName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map(norm))
  const name = base.trim()
  if (!taken.has(norm(name))) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(norm(candidate))) return candidate
  }
}
