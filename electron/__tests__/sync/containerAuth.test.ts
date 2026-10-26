/**
 * Sync of collection/folder auth (docs/SYNC_DESIGN.md section 21.6, feature `container_auth`): with a server before
 * it (no `container_auth`) it stays on the device without any noise; once the server offers the feature, the next
 * sync uploads it and the other device receives it, merging as its own field group.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { converge, liveState, makePair, pendingCount, settle, type Pair } from './harness'
import { rows } from './fuzzKit'

const BEARER = (token: string) => JSON.stringify({ type: 'bearer', bearer: [{ key: 'token', value: token, type: 'string' }] })

let cloud: FakeCloud
const pairs: Pair[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
})
afterEach(async () => {
  for (const p of pairs.splice(0)) {
    p.a.cleanup()
    p.b.cleanup()
  }
  await cloud.stop()
})

async function pair(): Promise<Pair & { col: string; folder: string }> {
  const ids = { col: '', folder: '' }
  const p = await makePair(cloud, async (a, ws) => {
    const col = await a.api.createCollection(ws, 'Payments')
    const folder = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Admin' })
    await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: folder.id, name: 'R', method: 'GET', url: 'https://x', documentJson: '{"auth":null}' })
    Object.assign(ids, { col: col.id, folder: folder.id })
  })
  pairs.push(p)
  return Object.assign(p, ids)
}
const authOf = (p: Pair, dev: 'a' | 'b', table: 'collections' | 'folders', id: string) =>
  (rows<{ auth_json: string | null }>(p[dev], `SELECT auth_json FROM ${table} WHERE id = ?`, id)[0] as { auth_json: string | null }).auth_json
const pushedOps = () => cloud.requests.filter((r) => /sync\/push$/.test(r.path)).map((r) => JSON.stringify(JSON.parse(r.body).operations)).join('\n')

describe('container auth sync', () => {
  it('stays on the device with a server without container_auth (nothing pushed, nothing pending, no conflict); an upgrade uploads it', async () => {
    cloud.containerAuth = false
    const p = await pair()
    await p.a.api.setCollectionAuth(p.col, BEARER('{{token}}'))
    await p.a.api.setFolderAuth(p.folder, '{"type":"noauth"}')
    const s = await settle(p.a, p.wsA)
    expect(s).toMatchObject({ pendingChanges: 0, openConflicts: 0, lastError: null })
    expect(pushedOps()).not.toContain('auth_json')
    await settle(p.b, p.wsB)
    expect(authOf(p, 'b', 'collections', p.col)).toBeNull()
    expect(pendingCount(p.a, p.wsA)).toBe(0)

    // The server gains the feature: A's local values are uploaded, B receives them.
    cloud.containerAuth = true
    await converge(p)
    expect(authOf(p, 'b', 'collections', p.col)).toBe(BEARER('{{token}}'))
    expect(authOf(p, 'b', 'folders', p.folder)).toBe('{"type":"noauth"}')
    expect(cloud.live(p.remoteId, 'collection')[0]!.data.auth_json).toBe(BEARER('{{token}}'))
    expect([...(await p.a.api.listSyncConflicts(p.wsA, true)), ...(await p.b.api.listSyncConflicts(p.wsB, true))]).toEqual([])
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  })

  it('with the feature: edits travel both ways; auth and name edited on different devices merge; different auths conflict in "auth" only', async () => {
    const p = await pair()
    await p.b.api.setFolderAuth(p.folder, BEARER('from-b'))
    await converge(p)
    expect(authOf(p, 'a', 'folders', p.folder)).toBe(BEARER('from-b'))

    await p.a.api.setCollectionAuth(p.col, BEARER('a'))
    await p.b.api.renameCollection(p.col, 'Payments v2')
    await converge(p)
    expect(rows(p.a, 'SELECT name, auth_json FROM collections WHERE id = ?', p.col)).toEqual([{ name: 'Payments v2', auth_json: BEARER('a') }])
    expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))

    await p.a.api.setFolderAuth(p.folder, BEARER('one'))
    await p.b.api.setFolderAuth(p.folder, BEARER('two'))
    await converge(p)
    const open = [...(await p.a.api.listSyncConflicts(p.wsA)), ...(await p.b.api.listSyncConflicts(p.wsB))]
    expect(open).toHaveLength(1)
    expect(open[0]!.groups.filter((g) => g.conflicting).map((g) => [g.group, g.label])).toEqual([['auth', 'Authorization']])
    expect(open[0]!.groups.find((g) => g.group === 'auth')!.local).toMatch(/type: bearer\ntoken: (one|two)/)
  })

  it('a request document never gets a copy of the inherited auth', async () => {
    const p = await pair()
    await p.a.api.setCollectionAuth(p.col, BEARER('secret-ish'))
    await converge(p)
    const docs = rows<{ document_json: string }>(p.b, 'SELECT document_json FROM requests').map((r) => r.document_json)
    expect(docs.join('\n')).not.toContain('secret-ish')
  })
})
