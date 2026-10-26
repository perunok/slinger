/**
 * Collection- and folder-level auth (Postman `auth` on a collection or folder item), shared by the main process and the
 * mock backend so both store exactly the same value.
 *
 * Stored as the Postman `auth` object in JSON text, never with an OAuth 2.0 token (shared/oauth2.ts). `null` means
 * "nothing set here": a folder then inherits from its parent folder or the collection, a collection has no auth.
 * `{"type":"noauth"}` on a folder stops inheritance; on a collection it is the same as null and stored as null.
 * Postman's `{"type":"inherit"}` (and a missing type) are read as null. Requests resolve the chain at send time
 * (src/lib/authInheritance.ts).
 */
import { stripOAuth2Tokens } from './oauth2'

export type ContainerLevel = 'collection' | 'folder'

/** The largest stored auth (UTF-8 bytes); far above any real one, it only guards against nonsense input. */
export const MAX_AUTH_JSON_BYTES = 1024 * 1024

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** The stored form of a Postman auth object for this level (null for "nothing set"). Never throws. */
export function containerAuthValue(auth: unknown, level: ContainerLevel): Json | null {
  if (!isObj(auth) || typeof auth.type !== 'string' || !auth.type.trim()) return null
  const type = auth.type.trim()
  if (type === 'inherit') return null
  if ((type === 'noauth' || type === 'none') && level === 'collection') return null
  if (type === 'noauth' || type === 'none') return { type: 'noauth' }
  return stripOAuth2Tokens(auth)
}

/** For importers: a Postman item's `auth` as the JSON text to store, or null. Lenient (anything unusable = null). */
export function containerAuthFromPostman(auth: unknown, level: ContainerLevel): string | null {
  const v = containerAuthValue(auth, level)
  return v ? JSON.stringify(v) : null
}

/** Validates an `authJson` argument (setCollectionAuth / setFolderAuth). */
export function cleanContainerAuthJson(value: unknown, level: ContainerLevel): { ok: true; json: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, json: null }
  if (typeof value !== 'string') return { ok: false, error: 'authJson must be a string or null' }
  if (new TextEncoder().encode(value).length > MAX_AUTH_JSON_BYTES) return { ok: false, error: 'auth is too large (1 MB max)' }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: false, error: 'authJson must be valid JSON' }
  }
  if (parsed === null) return { ok: true, json: null }
  if (!isObj(parsed) || typeof parsed.type !== 'string') return { ok: false, error: 'authJson must be a Postman auth object with a "type"' }
  const v = containerAuthValue(parsed, level)
  return { ok: true, json: v ? JSON.stringify(v) : null }
}

/** Parsed stored auth (null when none or unreadable). */
export function parseContainerAuthJson(json: string | null | undefined): Json | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    return isObj(v) ? v : null
  } catch {
    return null
  }
}
