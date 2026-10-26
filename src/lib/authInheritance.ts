/**
 * Postman-style auth inheritance. A request whose auth is `inherit` uses the auth of the nearest folder above it that
 * sets one (a folder set to "No auth" stops the walk), else the collection's ("No auth" when it has none). Folders and
 * collections store their auth as Postman `auth` JSON (`authJson`, shared/containerAuth.ts).
 *
 * Resolution happens at send time on a COPY of the draft (`withEffectiveAuth`), before scripts and templates, so every
 * path that sends through `executeDraft` (single send, runner, workflows, assistants) and code snippets resolve alike.
 */
import type { ApiFolder, Collection } from '../../shared/types'
import { containerAuthValue, parseContainerAuthJson, type ContainerLevel } from '../../shared/containerAuth'
import { emptyAuth, parseAuth, serializeAuth, type AuthDraft, type RequestDraft } from './request'

export interface AuthChain {
  collection: Pick<Collection, 'id' | 'name' | 'authJson'> | null | undefined
  /** The collection's folders (any order). */
  folders: ReadonlyArray<Pick<ApiFolder, 'id' | 'name' | 'parentFolderId' | 'authJson'>>
  /** The folder the request is in (null: top level of the collection). */
  folderId: string | null | undefined
}

/** Where an inherited auth comes from. */
export interface AuthSource {
  kind: 'collection' | 'folder'
  id: string
  name: string
}

export interface EffectiveAuth {
  /** The auth to send; never `inherit`. */
  auth: AuthDraft
  /** True when the request's own auth is `inherit`. */
  inherited: boolean
  /**
   * The folder or collection the auth comes from (the collection when nothing on the way sets one); null for a request's
   * own auth, or an inheriting request outside any collection (sent without auth).
   */
  source: AuthSource | null
}

/** The editable draft of a stored container auth: a folder without one inherits, a collection without one has none. */
export function containerAuthDraft(authJson: string | null | undefined, level: ContainerLevel): AuthDraft {
  const value = containerAuthValue(parseContainerAuthJson(authJson), level)
  if (!value) return level === 'folder' ? emptyAuth() : { ...emptyAuth(), kind: 'none' }
  return parseAuth(value)
}

/** The stored form of an edited container auth (setCollectionAuth / setFolderAuth). */
export function containerAuthJson(draft: AuthDraft, level: ContainerLevel): string | null {
  const value = containerAuthValue(serializeAuth(draft), level)
  return value ? JSON.stringify(value) : null
}

/** Walks folder -> parent folders -> collection for an `inherit` auth. */
export function resolveEffectiveAuth(own: AuthDraft, chain: AuthChain | null | undefined): EffectiveAuth {
  if (own.kind !== 'inherit') return { auth: own, inherited: false, source: null }
  const none: AuthDraft = { ...emptyAuth(), kind: 'none' }
  if (!chain?.collection) return { auth: none, inherited: true, source: null }
  const byId = new Map(chain.folders.map((f) => [f.id, f]))
  const seen = new Set<string>()
  let id = chain.folderId ?? null
  while (id && !seen.has(id)) {
    seen.add(id)
    const folder = byId.get(id)
    if (!folder) break
    const value = containerAuthValue(parseContainerAuthJson(folder.authJson), 'folder')
    if (value) return { auth: parseAuth(value), inherited: true, source: { kind: 'folder', id: folder.id, name: folder.name } }
    id = folder.parentFolderId
  }
  const c = chain.collection
  const value = containerAuthValue(parseContainerAuthJson(c.authJson), 'collection')
  return { auth: value ? parseAuth(value) : none, inherited: true, source: { kind: 'collection', id: c.id, name: c.name } }
}

/** The draft with its effective auth (the same draft when its own auth applies). */
export function withEffectiveAuth(draft: RequestDraft, chain: AuthChain | null | undefined): RequestDraft {
  if (draft.auth.kind !== 'inherit') return draft
  return { ...draft, auth: resolveEffectiveAuth(draft.auth, chain).auth }
}

/** For a folder's own editor: what it would inherit when set to `inherit` (its parent's chain). */
export function parentAuthOf(folderParentId: string | null, chain: Omit<AuthChain, 'folderId'>): EffectiveAuth {
  return resolveEffectiveAuth(emptyAuth(), { ...chain, folderId: folderParentId })
}

export const AUTH_KIND_LABELS: Record<AuthDraft['kind'], string> = {
  inherit: 'Inherit auth from parent',
  none: 'No Auth',
  basic: 'Basic Auth',
  bearer: 'Bearer Token',
  apiKey: 'API Key',
  oauth2: 'OAuth 2.0',
  unsupported: 'Unsupported',
}

/** "Bearer Token", or the unsupported type's name. */
export function authKindLabel(a: AuthDraft): string {
  return a.kind === 'unsupported' ? `${a.unsupportedType ?? 'Custom'} (unsupported)` : AUTH_KIND_LABELS[a.kind]
}
