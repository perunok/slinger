import { describe, expect, it } from 'vitest'
import { containerAuthDraft, containerAuthJson, parentAuthOf, resolveEffectiveAuth, withEffectiveAuth, type AuthChain } from './authInheritance'
import { emptyAuth, newDraft, parseAuth, parseDocument, serializeAuth, serializeDraft } from './request'

const bearer = (token: string) => JSON.stringify({ type: 'bearer', bearer: [{ key: 'token', value: token, type: 'string' }] })
const BEARER = bearer
const NOAUTH = '{"type":"noauth"}'

function chain(over: { collection?: string | null; a?: string | null; b?: string | null; folderId?: string | null } = {}): AuthChain {
  return {
    collection: { id: 'c', name: 'Coll', authJson: over.collection === undefined ? bearer('root') : over.collection },
    // a (top) > b (inside a)
    folders: [
      { id: 'a', name: 'A', parentFolderId: null, authJson: over.a ?? null },
      { id: 'b', name: 'B', parentFolderId: 'a', authJson: over.b ?? null },
    ],
    folderId: over.folderId === undefined ? 'b' : over.folderId,
  }
}

describe('request auth kinds', () => {
  it('absent / null / {type: inherit} is inherit (the default for new requests); noauth is none', () => {
    expect(emptyAuth().kind).toBe('inherit')
    expect(newDraft().auth.kind).toBe('inherit')
    expect(parseAuth(undefined).kind).toBe('inherit')
    expect(parseAuth(null).kind).toBe('inherit')
    expect(parseAuth({ type: 'inherit' }).kind).toBe('inherit')
    expect(parseAuth({ type: 'noauth' }).kind).toBe('none')
    expect(serializeAuth({ ...emptyAuth(), kind: 'none' })).toEqual({ type: 'noauth' })
    expect(serializeAuth(emptyAuth())).toBeNull()
  })

  it('round-trips both through the document', () => {
    const inherit = serializeDraft(newDraft({ url: 'http://x' }))
    expect(JSON.parse(inherit.documentJson).auth).toBeNull()
    expect(parseDocument(inherit).auth.kind).toBe('inherit')
    const none = serializeDraft(newDraft({ url: 'http://x', auth: { ...emptyAuth(), kind: 'none' } }))
    expect(JSON.parse(none.documentJson).auth).toEqual({ type: 'noauth' })
    expect(parseDocument(none).auth.kind).toBe('none')
  })
})

describe('resolveEffectiveAuth', () => {
  it("a request's own auth wins", () => {
    const own = parseAuth(JSON.parse(bearer('mine')))
    expect(resolveEffectiveAuth(own, chain())).toEqual({ auth: own, inherited: false, source: null })
  })

  it('walks folder -> parent folders -> collection', () => {
    expect(resolveEffectiveAuth(emptyAuth(), chain({ b: bearer('b') }))).toMatchObject({ inherited: true, source: { kind: 'folder', id: 'b', name: 'B' }, auth: { kind: 'bearer', bearer: { token: 'b' } } })
    expect(resolveEffectiveAuth(emptyAuth(), chain({ a: bearer('a') }))).toMatchObject({ source: { kind: 'folder', id: 'a' }, auth: { bearer: { token: 'a' } } })
    expect(resolveEffectiveAuth(emptyAuth(), chain())).toMatchObject({ source: { kind: 'collection', id: 'c', name: 'Coll' }, auth: { bearer: { token: 'root' } } })
    expect(resolveEffectiveAuth(emptyAuth(), chain({ folderId: null }))).toMatchObject({ source: { kind: 'collection' } })
  })

  it('a folder set to "No auth" stops the walk; a collection without auth gives none', () => {
    expect(resolveEffectiveAuth(emptyAuth(), chain({ a: NOAUTH }))).toMatchObject({ source: { kind: 'folder', id: 'a' }, auth: { kind: 'none' } })
    expect(resolveEffectiveAuth(emptyAuth(), chain({ collection: null }))).toMatchObject({ source: { kind: 'collection' }, auth: { kind: 'none' } })
    // A collection stored as noauth is the same as none.
    expect(resolveEffectiveAuth(emptyAuth(), chain({ collection: NOAUTH }))).toMatchObject({ auth: { kind: 'none' } })
  })

  it('outside a collection, an inheriting request is sent without auth; corrupt or cyclic data does not hang', () => {
    expect(resolveEffectiveAuth(emptyAuth(), null)).toMatchObject({ inherited: true, source: null, auth: { kind: 'none' } })
    const cyclic: AuthChain = {
      collection: { id: 'c', name: 'C', authJson: 'not json' },
      folders: [{ id: 'x', name: 'X', parentFolderId: 'y', authJson: '{}' }, { id: 'y', name: 'Y', parentFolderId: 'x', authJson: null }],
      folderId: 'x',
    }
    expect(resolveEffectiveAuth(emptyAuth(), cyclic)).toMatchObject({ source: { kind: 'collection' }, auth: { kind: 'none' } })
  })

  it('withEffectiveAuth replaces only an inherit auth, on a copy', () => {
    const d = newDraft({ url: 'http://x' })
    const sent = withEffectiveAuth(d, chain())
    expect(sent.auth).toMatchObject({ kind: 'bearer', bearer: { token: 'root' } })
    expect(d.auth.kind).toBe('inherit')
    const own = newDraft({ auth: { ...emptyAuth(), kind: 'none' } })
    expect(withEffectiveAuth(own, chain())).toBe(own)
  })

  it("parentAuthOf: what a folder set to inherit gets from above it", () => {
    const c = chain({ a: bearer('a') })
    expect(parentAuthOf('a', c)).toMatchObject({ source: { kind: 'folder', id: 'a' } })
    expect(parentAuthOf(null, c)).toMatchObject({ source: { kind: 'collection' } })
  })
})

describe('container auth drafts', () => {
  it('a folder without auth inherits, a collection without auth has none', () => {
    expect(containerAuthDraft(null, 'folder').kind).toBe('inherit')
    expect(containerAuthDraft(null, 'collection').kind).toBe('none')
    expect(containerAuthDraft(NOAUTH, 'folder').kind).toBe('none')
    expect(containerAuthDraft(bearer('t'), 'collection')).toMatchObject({ kind: 'bearer', bearer: { token: 't' } })
  })

  it('stores inherit as null, folder "No auth" as noauth, collection "No auth" as null', () => {
    expect(containerAuthJson(emptyAuth(), 'folder')).toBeNull()
    expect(containerAuthJson({ ...emptyAuth(), kind: 'none' }, 'folder')).toBe(NOAUTH)
    expect(containerAuthJson({ ...emptyAuth(), kind: 'none' }, 'collection')).toBeNull()
    expect(containerAuthJson(emptyAuth(), 'collection')).toBeNull()
    const draft = containerAuthDraft(bearer('t'), 'collection')
    expect(JSON.parse(containerAuthJson(draft, 'collection')!)).toEqual(JSON.parse(bearer('t')))
  })
})

describe('version snapshots', () => {
  it('never keep an OAuth 2.0 token in collection or folder auth', async () => {
    const { stripOAuth2TokensFromSnapshot } = await import('../../shared/oauth2')
    const auth = JSON.stringify({ type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'TKN' }, { key: 'clientId', value: 'c' }] })
    const snap = { collectionName: 'C', collectionAuthJson: auth, folders: [{ id: 'f', parentFolderId: null, name: 'F', sortOrder: 0, authJson: auth }], requests: [] }
    const out = stripOAuth2TokensFromSnapshot(snap)
    expect(JSON.stringify(out)).not.toContain('TKN')
    expect(JSON.parse(out.collectionAuthJson!).oauth2).toEqual([{ key: 'clientId', value: 'c' }])
    const clean = { collectionName: 'C', collectionAuthJson: BEARER('x'), folders: [], requests: [] }
    expect(stripOAuth2TokensFromSnapshot(clean)).toBe(clean)
  })
})
