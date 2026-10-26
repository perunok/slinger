/**
 * Collection- and folder-level auth in the main process (migration 0018): the setters, version snapshots, extract to a
 * new collection, and OpenAPI import/update keeping one shared auth on the collection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fingerprintDocument } from '../../shared/openapi/fingerprint'
import { clearPlans } from '../openapi/update'
import { makeEnv, scaffold, type TestEnv } from './helpers'

const BEARER = (token: string) => JSON.stringify({ type: 'bearer', bearer: [{ key: 'token', value: token, type: 'string' }] })

let env: TestEnv
let ws: string
beforeEach(async () => {
  env = makeEnv()
  clearPlans()
  ws = (await scaffold(env)).workspace.id
})
afterEach(() => env.cleanup())

async function tree() {
  const col = await env.api.createCollection(ws, 'C')
  const top = await env.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Top' })
  const sub = await env.api.createFolder({ workspaceId: ws, collectionId: col.id, parentFolderId: top.id, name: 'Sub' })
  await env.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: sub.id, name: 'R', method: 'GET', url: 'https://x', documentJson: '{"auth":null}' })
  return { col, top, sub }
}

describe('setCollectionAuth / setFolderAuth', () => {
  it('store the Postman auth; "No auth" is null on a collection and kept on a folder; null clears', async () => {
    const { col, top } = await tree()
    expect((await env.api.setCollectionAuth(col.id, BEARER('{{t}}'))).authJson).toBe(BEARER('{{t}}'))
    expect((await env.api.listCollections(ws)).find((c) => c.id === col.id)!.authJson).toBe(BEARER('{{t}}'))
    expect((await env.api.setCollectionAuth(col.id, '{"type":"noauth"}')).authJson).toBeNull()
    expect((await env.api.setFolderAuth(top.id, '{"type":"noauth"}')).authJson).toBe('{"type":"noauth"}')
    expect((await env.api.setFolderAuth(top.id, '{"type":"inherit"}')).authJson).toBeNull()
    expect((await env.api.setFolderAuth(top.id, null)).authJson).toBeNull()
  })

  it('never store an OAuth 2.0 token and reject anything that is not a Postman auth object', async () => {
    const { col, top } = await tree()
    const withToken = JSON.stringify({ type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'TOKEN-1' }, { key: 'clientId', value: 'app' }] })
    const stored = (await env.api.setCollectionAuth(col.id, withToken)).authJson!
    expect(stored).not.toContain('TOKEN-1')
    expect(JSON.parse(stored).oauth2).toEqual([{ key: 'clientId', value: 'app' }])
    expect(JSON.stringify(env.core.db.prepare('SELECT auth_json FROM collections').all())).not.toContain('TOKEN-1')
    for (const bad of ['not json', '[]', '{"no":"type"}', '"bearer"']) {
      await expect(env.api.setFolderAuth(top.id, bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(env.api.setCollectionAuth(col.id, 'x'.repeat(3 * 1024 * 1024))).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('versions', () => {
  it('snapshot collection and folder auth; restore (replace and copy) brings them back', async () => {
    const { col, top } = await tree()
    await env.api.setCollectionAuth(col.id, BEARER('v1'))
    await env.api.setFolderAuth(top.id, '{"type":"noauth"}')
    const v = await env.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
    const snap = (await env.api.getCollectionVersion(v.id)).snapshot
    expect(snap.collectionAuthJson).toBe(BEARER('v1'))
    expect(snap.folders.find((f) => f.name === 'Top')!.authJson).toBe('{"type":"noauth"}')
    expect(snap.folders.find((f) => f.name === 'Sub')!.authJson).toBeUndefined()

    await env.api.setCollectionAuth(col.id, BEARER('v2'))
    await env.api.setFolderAuth(top.id, null)
    const restored = await env.api.restoreCollectionVersion(v.id, 'replace')
    expect(restored.authJson).toBe(BEARER('v1'))
    expect((await env.api.listFolders(col.id)).find((f) => f.name === 'Top')!.authJson).toBe('{"type":"noauth"}')
    const copy = await env.api.restoreCollectionVersion(v.id, 'copy')
    expect(copy.authJson).toBe(BEARER('v1'))
    expect((await env.api.listFolders(copy.id)).find((f) => f.name === 'Top')!.authJson).toBe('{"type":"noauth"}')
  })
})

describe('extract folder to a new collection', () => {
  it('the new collection gets what the folder inherited; subfolders keep their own', async () => {
    const { col, top, sub } = await tree()
    await env.api.setCollectionAuth(col.id, BEARER('root'))
    await env.api.setFolderAuth(sub.id, BEARER('sub'))
    const fromCollection = await env.api.extractFolderToCollection({ folderId: top.id, name: 'Top', copyCollectionVariables: false })
    expect(fromCollection.collection.authJson).toBe(BEARER('root'))
    expect((await env.api.listFolders(fromCollection.collection.id))[0]!.authJson).toBe(BEARER('sub'))

    const again = await tree()
    await env.api.setFolderAuth(again.top.id, '{"type":"noauth"}')
    await env.api.setCollectionAuth(again.col.id, BEARER('root'))
    const fromFolder = await env.api.extractFolderToCollection({ folderId: again.sub.id, name: 'Sub', copyCollectionVariables: false })
    expect(fromFolder.collection.authJson).toBeNull() // the parent folder's "No auth"
  })
})

describe('OpenAPI', () => {
  const SPEC = (version: string, scheme: 'bearer' | 'basic') => `openapi: 3.0.3
info: { title: Secure API, version: ${version} }
servers: [{ url: https://api.example.com }]
security: [{ main: [] }]
components:
  securitySchemes:
    main: { type: http, scheme: ${scheme} }
paths:
  /a:
    get: { operationId: getA, responses: { '200': { description: ok } } }
  /b:
    get: { operationId: getB, responses: { '200': { description: ok } } }
`
  const TEXT = { kind: 'text', value: null } as const

  it('a security requirement shared by every operation becomes the collection auth; requests inherit it', async () => {
    const r = await env.api.importOpenApi({ workspaceId: ws, text: SPEC('1.0.0', 'bearer'), source: TEXT, folders: 'none' })
    expect(JSON.parse(r.collection.authJson!)).toMatchObject({ type: 'bearer' })
    for (const req of r.requests) expect(JSON.parse(req.documentJson).auth).toBeNull()
    // Nothing to update against the same document.
    const plan = await env.api.planOpenApiUpdate({ collectionId: r.collection.id, text: SPEC('1.0.0', 'bearer'), source: TEXT })
    expect(plan.changes.every((c) => c.kind === 'unchanged')).toBe(true)
    expect(plan.notes).toEqual([])
  })

  it('an update follows the document\'s shared auth unless the collection auth was changed here', async () => {
    const r = await env.api.importOpenApi({ workspaceId: ws, text: SPEC('1.0.0', 'bearer'), source: TEXT, folders: 'none' })
    const plan = await env.api.planOpenApiUpdate({ collectionId: r.collection.id, text: SPEC('1.1.0', 'basic'), source: TEXT })
    expect(plan.notes).toContain('Collection authorization: bearer -> basic')
    await env.api.applyOpenApiUpdate({ collectionId: r.collection.id, planId: plan.planId, choices: {} })
    expect(JSON.parse((await env.api.listCollections(ws)).find((c) => c.id === r.collection.id)!.authJson!)).toMatchObject({ type: 'basic' })

    await env.api.setCollectionAuth(r.collection.id, BEARER('{{mine}}'))
    const kept = await env.api.planOpenApiUpdate({ collectionId: r.collection.id, text: SPEC('1.2.0', 'bearer'), source: TEXT })
    expect(kept.notes.some((n) => /keeps bearer \(it was changed here\)/.test(n))).toBe(true)
  })

  it('a collection imported before container auth (auth copied into every request) gets it back on the collection', async () => {
    const r = await env.api.importOpenApi({ workspaceId: ws, text: SPEC('1.0.0', 'bearer'), source: TEXT, folders: 'none' })
    const auth = JSON.parse(r.collection.authJson!)
    // As an older version stored it: no collection auth, every request with a copy (and a fingerprint including it).
    env.core.db.prepare('UPDATE collections SET auth_json = NULL WHERE id = ?').run(r.collection.id)
    for (const req of r.requests) {
      const doc = JSON.parse(req.documentJson)
      doc.auth = auth
      doc.openapi.itemHash = fingerprintDocument(doc, req.method, req.url)
      env.core.db.prepare('UPDATE requests SET document_json = ? WHERE id = ?').run(JSON.stringify(doc), req.id)
    }
    const plan = await env.api.planOpenApiUpdate({ collectionId: r.collection.id, text: SPEC('1.0.0', 'bearer'), source: TEXT })
    expect(plan.notes).toContain('Collection authorization: none -> bearer')
    await env.api.applyOpenApiUpdate({ collectionId: r.collection.id, planId: plan.planId, choices: {} })
    expect(JSON.parse((await env.api.listCollections(ws)).find((c) => c.id === r.collection.id)!.authJson!)).toEqual(auth)
    for (const req of await env.api.listRequests(r.collection.id)) expect(JSON.parse(req.documentJson).auth).toBeNull()
  })
})
