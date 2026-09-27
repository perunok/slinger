/**
 * Sync of the formerly local-only data (docs/SYNC_DESIGN.md section 21): collection/folder scripts and docs,
 * collection variables and globals. Mapping/merge units plus two devices against the fake server, including an
 * older server without the features and its upgrade.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SyncConflict } from '../../../shared/types'
import { ALL_FEATURES, NO_FEATURES, checkLimits, groupsOf, normalizeIncoming, toWire, type AnyRow } from '../../sync/mapping'
import { merge } from '../../sync/merge'
import { FakeCloud } from './fakeCloud'
import { converge, liveState, makeDevice, makePair, pendingCount, settle, type Device, type Pair } from './harness'
import { rows } from './fuzzKit'

const SCRIPT = (code: string) => JSON.stringify([{ listen: 'prerequest', script: { exec: code.split('\n'), type: 'text/javascript' } }])

describe('mapping', () => {
  const col = { name: 'C', scripts_json: SCRIPT('a'), description: '# D', description_type: 'text/markdown' } as AnyRow
  it('collection/folder extras follow the link features', () => {
    expect(toWire('collection', col, NO_FEATURES)).toEqual({ name: 'C' })
    expect(toWire('collection', col, new Set(['docs']))).toEqual({ name: 'C', description: '# D', description_type: 'text/markdown' })
    expect(toWire('collection', col, ALL_FEATURES)).toEqual({ name: 'C', scripts_json: SCRIPT('a'), description: '# D', description_type: 'text/markdown' })
    expect(toWire('folder', { collection_id: 'c', parent_folder_id: null, name: 'F', sort_order: 1, scripts_json: null, description: null, description_type: 'bogus' } as AnyRow, ALL_FEATURES))
      .toEqual({ collection_id: 'c', parent_folder_id: null, name: 'F', sort_order: 1, scripts_json: null, description: null, description_type: null })
  })

  it('variables: collection variables are never secret, a secret global never carries its value', () => {
    expect(toWire('collection_variable', { collection_id: 'c', key: 'k', value: 'v', enabled: 0, description: null, sort_order: 2 } as AnyRow, ALL_FEATURES))
      .toEqual({ collection_id: 'c', key: 'k', value: 'v', enabled: false, description: null, sort_order: 2 })
    expect(toWire('global_variable', { key: 't', value: 'LEAK?', is_secret: 1, enabled: 1, description: 'x', sort_order: 0 } as AnyRow, ALL_FEATURES))
      .toEqual({ key: 't', value: null, is_secret: true, enabled: true, description: 'x', sort_order: 0 })
  })

  it('incoming payloads: missing enabled fields are null, disabled ones are dropped', () => {
    expect(normalizeIncoming('collection', { name: 'C' }, ALL_FEATURES)).toEqual({ name: 'C', scripts_json: null, description: null, description_type: null })
    expect(normalizeIncoming('folder', { name: 'F', scripts_json: 'x', description: 'd' }, new Set(['folder_scripts'])))
      .toEqual({ name: 'F', scripts_json: 'x' })
    const same = { name: 'E' }
    expect(normalizeIncoming('environment', same, ALL_FEATURES)).toBe(same)
  })

  it('limits and groups', () => {
    expect(checkLimits('collection', { name: 'C', scripts_json: 'x'.repeat(2 * 1024 * 1024 + 1) })).toMatch(/scripts are larger/)
    expect(checkLimits('folder', { name: 'F', description: 'é'.repeat(1024 * 1024 + 1) })).toMatch(/documentation is larger/)
    expect(checkLimits('collection_variable', { key: 'k'.repeat(257) })).toMatch(/not accepted/)
    expect(checkLimits('global_variable', { key: ' padded' })).toMatch(/not accepted/)
    expect(checkLimits('global_variable', { key: 'any name / with: spaces', value: 'v' })).toBeNull()
    expect(checkLimits('collection_variable', { key: 'k', value: 'v'.repeat(1_000_001) })).toMatch(/longer than/)
    expect(groupsOf('folder', NO_FEATURES).map(([g]) => g)).toEqual(['name', 'location', 'order'])
    expect(groupsOf('folder', ALL_FEATURES).map(([g]) => g)).toEqual(['name', 'location', 'order', 'scripts', 'docs'])
  })
})

describe('merge', () => {
  const base = { collection_id: 'c', parent_folder_id: null, name: 'F', sort_order: 0, scripts_json: null, description: null, description_type: null }
  it("a folder's script and its name edited on different devices merge without a conflict", () => {
    const m = merge('folder', base, { ...base, scripts_json: SCRIPT('local') }, { ...base, name: 'Renamed' })
    expect(m.conflicting).toEqual([])
    expect(m.merged).toMatchObject({ name: 'Renamed', scripts_json: SCRIPT('local') })
    expect(m.takenLocal).toEqual(['scripts'])
  })
  it('different scripts on both sides conflict in group scripts only; docs are their own group', () => {
    const m = merge('folder', base, { ...base, scripts_json: SCRIPT('a'), description: 'mine' }, { ...base, scripts_json: SCRIPT('b') })
    expect(m.conflicting).toEqual(['scripts'])
    expect(m.merged).toMatchObject({ description: 'mine' })
  })
  it('variables: value and details are separate groups; order takes the remote silently', () => {
    const v = { collection_id: 'c', key: 'k', value: '1', enabled: true, description: null, sort_order: 0 }
    const m = merge('collection_variable', v, { ...v, value: '2', sort_order: 5 }, { ...v, enabled: false, sort_order: 3 })
    expect(m.conflicting).toEqual([])
    expect(m.merged).toEqual({ ...v, value: '2', enabled: false, sort_order: 3 })
    const g = { key: 't', value: null, is_secret: true, enabled: true, description: null, sort_order: 0 }
    expect(merge('global_variable', g, { ...g, key: 'a' }, { ...g, key: 'b' }).conflicting).toEqual(['key'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------

let cloud: FakeCloud
let pairs: Pair[] = []
let devices: Device[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  pairs = []
  devices = []
})
afterEach(async () => {
  for (const p of pairs) {
    p.a.cleanup()
    p.b.cleanup()
  }
  devices.forEach((d) => d.cleanup())
  await cloud.stop()
})

interface Seed {
  col: string
  folder: string
}
async function pair(seed?: (a: Device, ws: string, s: Seed) => Promise<void>): Promise<Pair & { s: Seed }> {
  const s = {} as Seed
  const p = await makePair(cloud, async (a, ws) => {
    const col = await a.api.createCollection(ws, 'Payments')
    const folder = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Auth' })
    Object.assign(s, { col: col.id, folder: folder.id })
    await seed?.(a, ws, s)
  })
  pairs.push(p)
  return Object.assign(p, { s })
}
const one = <T>(d: Device, sql: string, ...args: unknown[]) => rows<T & Record<string, string | number | null>>(d, sql, ...args)[0] as T
const conflicts = (d: Device, ws: string): Promise<SyncConflict[]> => d.api.listSyncConflicts(ws)
const pushedBodies = () => cloud.requests.filter((r) => /sync\/push$/.test(r.path)).map((r) => r.body).join('\n')
function sameEverywhere(p: Pair): void {
  expect(liveState(p.a, p.wsA)).toEqual(liveState(p.b, p.wsB))
  const server = cloud.live(p.remoteId).map((e) => `${e.type}:${e.id}:${JSON.stringify(cloud.wireOf(e))}`)
  expect(server.length).toBe(liveState(p.a, p.wsA).length)
}

describe('two devices', () => {
  it('scripts and docs of collections and folders reach the other device (publish, link, edits)', async () => {
    const p = await pair(async (a, _ws, s) => {
      await a.api.setCollectionScripts(s.col, SCRIPT('pm.globals.set("t", 1)'))
      await a.api.setCollectionDescription(s.col, '# Payments API')
      await a.api.setFolderScripts(s.folder, SCRIPT('console.log(1)'))
    })
    expect(one<{ scripts_json: string; description: string }>(p.b, 'SELECT scripts_json, description FROM collections WHERE id = ?', p.s.col))
      .toEqual({ scripts_json: SCRIPT('pm.globals.set("t", 1)'), description: '# Payments API' })
    expect(one<{ scripts_json: string }>(p.b, 'SELECT scripts_json FROM folders WHERE id = ?', p.s.folder).scripts_json).toBe(SCRIPT('console.log(1)'))
    await p.b.api.setFolderDescription(p.s.folder, 'Folder docs')
    await p.b.api.setCollectionScripts(p.s.col, null)
    await converge(p)
    expect(one<{ description: string }>(p.a, 'SELECT description FROM folders WHERE id = ?', p.s.folder).description).toBe('Folder docs')
    expect(one<{ scripts_json: string | null }>(p.a, 'SELECT scripts_json FROM collections WHERE id = ?', p.s.col).scripts_json).toBeNull()
    sameEverywhere(p)
  })

  it("a concurrent edit of a folder's script and its name merges; different scripts on both sides are an edit_edit on `scripts` only", async () => {
    const p = await pair()
    await p.a.api.setFolderScripts(p.s.folder, SCRIPT('from A'))
    await p.b.api.renameFolder(p.s.folder, 'Auth v2')
    await converge(p)
    expect(await conflicts(p.a, p.wsA)).toEqual([])
    expect(await conflicts(p.b, p.wsB)).toEqual([])
    expect(one<{ name: string; scripts_json: string }>(p.b, 'SELECT name, scripts_json FROM folders WHERE id = ?', p.s.folder)).toEqual({ name: 'Auth v2', scripts_json: SCRIPT('from A') })

    await p.a.api.setFolderScripts(p.s.folder, SCRIPT('line 1\nA'))
    await p.b.api.setFolderScripts(p.s.folder, SCRIPT('line 1\nB'))
    await p.b.api.setFolderDescription(p.s.folder, 'B docs')
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    const [c] = await conflicts(p.b, p.wsB)
    expect(c).toMatchObject({ kind: 'edit_edit', entityType: 'folder', allowedResolutions: ['keep_local', 'keep_remote', 'merge'] })
    const scripts = c!.groups.find((g) => g.group === 'scripts')!
    expect(scripts).toMatchObject({ conflicting: true, label: 'Scripts', local: '// Pre-request script\nline 1\nB', remote: '// Pre-request script\nline 1\nA' })
    expect(c!.groups.find((g) => g.group === 'docs')).toMatchObject({ conflicting: false, local: 'B docs' })
    await p.b.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'merge', fieldChoices: { scripts: 'remote' } })
    await converge(p)
    for (const d of [p.a, p.b]) {
      expect(one<{ scripts_json: string; description: string }>(d, 'SELECT scripts_json, description FROM folders WHERE id = ?', p.s.folder))
        .toEqual({ scripts_json: SCRIPT('line 1\nA'), description: 'B docs' })
    }
    sameEverywhere(p)
  })

  it('collection variables and globals sync; secret globals travel as metadata and are "missing" on the other device', async () => {
    const p = await pair(async (a, ws, s) => {
      await a.api.upsertCollectionVariable({ collectionId: s.col, key: 'base url', value: 'https://pay', description: 'host' })
      await a.api.upsertGlobalVariable({ workspaceId: ws, key: 'tenant', value: 'acme', isSecret: false })
      await a.api.upsertGlobalVariable({ workspaceId: ws, key: 'token', value: 'SECRET-global-1', isSecret: true })
    })
    expect((await p.b.api.listCollectionVariables(p.s.col)).map((v) => [v.key, v.value, v.description])).toEqual([['base url', 'https://pay', 'host']])
    const globals = await p.b.api.listGlobalVariables(p.wsB)
    expect(globals.map((g) => [g.key, g.value, g.isSecret, g.secretMissing])).toEqual([['tenant', 'acme', false, false], ['token', null, true, true]])
    // B sets its own value: nothing to push (the wire payload is unchanged)
    await p.b.api.upsertGlobalVariable({ workspaceId: p.wsB, variableId: globals[1]!.id, key: 'token', value: 'SECRET-global-b', isSecret: true })
    expect((await p.b.api.listGlobalVariables(p.wsB))[1]!.secretMissing).toBe(false)
    const st = await settle(p.b, p.wsB)
    expect(st.pendingChanges).toBe(0)
    expect(await p.b.api.revealGlobalVariable(globals[1]!.id)).toBe('SECRET-global-b')
    expect(await p.a.api.revealGlobalVariable(globals[1]!.id)).toBe('SECRET-global-1')
    // a key rename, disabling, reorder and delete travel; plaintext -> secret keeps B's plaintext as its local value
    const tenant = globals[0]!
    await p.a.api.upsertGlobalVariable({ workspaceId: p.wsA, variableId: tenant.id, key: 'tenant_id', value: 'acme', isSecret: true, enabled: false })
    await converge(p)
    const t = (await p.b.api.listGlobalVariables(p.wsB)).find((g) => g.id === tenant.id)!
    expect(t).toMatchObject({ key: 'tenant_id', isSecret: true, secretMissing: false, enabled: false })
    expect(await p.b.api.revealGlobalVariable(tenant.id)).toBe('acme')
    await p.b.api.deleteGlobalVariable(tenant.id)
    await converge(p)
    expect((await p.a.api.listGlobalVariables(p.wsA)).map((g) => g.key)).toEqual(['token'])
    expect(p.a.secrets.get(`slinger:global-var:${tenant.id}`)).toBeNull()
    expect(pushedBodies()).not.toContain('SECRET-global')
    sameEverywhere(p)
  })

  it('the same variable added on both devices folds into one; different values keep both (renamed)', async () => {
    const p = await pair()
    await p.a.api.upsertCollectionVariable({ collectionId: p.s.col, key: 'same', value: '1' })
    await p.b.api.upsertCollectionVariable({ collectionId: p.s.col, key: 'same', value: '1' })
    await p.a.api.upsertGlobalVariable({ workspaceId: p.wsA, key: 'sec', value: 'SECRET-a', isSecret: true })
    await p.b.api.upsertGlobalVariable({ workspaceId: p.wsB, key: 'sec', value: 'SECRET-b', isSecret: true })
    await p.a.api.upsertCollectionVariable({ collectionId: p.s.col, key: 'diff', value: 'A' })
    await p.b.api.upsertCollectionVariable({ collectionId: p.s.col, key: 'diff', value: 'B' })
    await converge(p)
    const vars = (await p.a.api.listCollectionVariables(p.s.col)).map((v) => `${v.key}=${v.value}`).sort()
    expect(vars).toEqual(['diff=A', 'diff_conflict=B', 'same=1'])
    // the secret global folded: one id everywhere, each device keeps its own value
    const [ga] = await p.a.api.listGlobalVariables(p.wsA)
    const [gb] = await p.b.api.listGlobalVariables(p.wsB)
    expect(ga!.id).toBe(gb!.id)
    expect(await p.a.api.revealGlobalVariable(ga!.id)).toBe('SECRET-a')
    expect(await p.b.api.revealGlobalVariable(gb!.id)).toBe('SECRET-b')
    const notes = [...(await p.a.api.listSyncConflicts(p.wsA, true)), ...(await p.b.api.listSyncConflicts(p.wsB, true))]
    expect(notes.map((c) => `${c.kind}:${c.label}`)).toEqual(['duplicate_key:diff'])
    expect(pushedBodies()).not.toContain('SECRET-')
    sameEverywhere(p)
  })

  it('a collection delete removes its variables; a variable edited meanwhile keeps the collection as remote_deleted', async () => {
    const p = await pair(async (a, _ws, s) => void (await a.api.upsertCollectionVariable({ collectionId: s.col, key: 'k', value: '1' })))
    const [v] = await p.b.api.listCollectionVariables(p.s.col)
    await p.a.api.deleteCollection(p.s.col)
    await p.b.api.upsertCollectionVariable({ collectionId: p.s.col, variableId: v!.id, key: 'k', value: 'edited' })
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    const open = await conflicts(p.b, p.wsB)
    expect(open.map((c) => `${c.kind}:${c.entityType}`).sort()).toEqual(['remote_deleted:collection', 'remote_deleted:collection_variable'])
    expect(open.find((c) => c.entityType === 'collection_variable')!.path).toEqual(['Payments', 'k'])
    await p.b.api.resolveSyncConflict({ conflictId: open.find((c) => c.entityType === 'collection')!.id, resolution: 'keep_remote' })
    await converge(p)
    expect(rows(p.b, 'SELECT id FROM collection_variables WHERE deleted = 0')).toEqual([])
    expect(cloud.live(p.remoteId, 'collection_variable')).toEqual([])
    sameEverywhere(p)
  })
})

describe('older server without the features', () => {
  it('keeps scripts, docs, collection variables and globals local: nothing pushed, nothing alarming; an upgrade uploads them', async () => {
    cloud.extensions = false
    const user = cloud.createUser('old@example.com')
    const a = makeDevice(cloud, { userId: user.id, deviceName: 'A' })
    devices.push(a)
    const ws = a.workspace.id
    const col = await a.api.createCollection(ws, 'C')
    await a.api.setCollectionScripts(col.id, SCRIPT('local only'))
    await a.api.setCollectionDescription(col.id, 'docs')
    await a.api.upsertCollectionVariable({ collectionId: col.id, key: 'cv', value: '1' })
    await a.api.upsertGlobalVariable({ workspaceId: ws, key: 'g', value: 'SECRET-old', isSecret: true })
    await a.api.publishWorkspace(ws)
    let s = await settle(a, ws)
    expect(s).toMatchObject({ state: 'idle', pendingChanges: 0, openConflicts: 0, lastError: null })
    expect(cloud.live(s.remoteWorkspaceId!).map((e) => e.type)).toEqual(['collection'])
    expect(cloud.live(s.remoteWorkspaceId!)[0]!.data).toEqual({ name: 'C' })
    // later local edits are no-ops for sync
    await a.api.setCollectionScripts(col.id, SCRIPT('still local'))
    await a.api.upsertCollectionVariable({ collectionId: col.id, key: 'cv2', value: '2' })
    s = await settle(a, ws)
    expect(s).toMatchObject({ pendingChanges: 0, openConflicts: 0, lastError: null })
    const ops = cloud.requests.filter((r) => /sync\/push$/.test(r.path)).map((r) => JSON.stringify(JSON.parse(r.body).operations)).join('\n')
    expect(ops).not.toMatch(/scripts_json|description|collection_variable|global_variable|SECRET/)
    expect(await a.api.listSyncConflicts(ws, true)).toEqual([])

    // A second device (new app) links meanwhile and has its own local-only data
    const b = makeDevice(cloud, { userId: user.id, deviceName: 'B' })
    devices.push(b)
    const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: s.remoteWorkspaceId!, localWorkspaceId: null })
    const wsB = link.workspace.id
    await settle(b, wsB)
    await b.api.setCollectionDescription(col.id, 'docs') // same text as A: no conflict after the upgrade
    await b.api.upsertCollectionVariable({ collectionId: col.id, key: 'cv', value: '1' }) // same as A's: folds
    await settle(b, wsB)

    // the server is upgraded: the next cycles activate the features and upload the local data
    cloud.extensions = true
    s = await settle(a, ws)
    await settle(b, wsB)
    s = await settle(a, ws)
    expect(s).toMatchObject({ pendingChanges: 0, openConflicts: 0, lastError: null })
    const server = cloud.live(s.remoteWorkspaceId!)
    expect(server.find((e) => e.type === 'collection')!.data).toMatchObject({ scripts_json: SCRIPT('still local'), description: 'docs' })
    expect(server.filter((e) => e.type === 'collection_variable').map((e) => e.data.key).sort()).toEqual(['cv', 'cv2'])
    expect(server.filter((e) => e.type === 'global_variable').map((e) => cloud.wireOf(e))).toEqual([
      { key: 'g', value: null, is_secret: true, enabled: true, description: null, sort_order: 0 },
    ])
    expect(one<{ scripts_json: string }>(b, 'SELECT scripts_json FROM collections WHERE id = ?', col.id).scripts_json).toBe(SCRIPT('still local'))
    expect((await b.api.listCollectionVariables(col.id)).map((v) => v.key).sort()).toEqual(['cv', 'cv2'])
    expect((await b.api.listGlobalVariables(wsB)).map((g) => [g.key, g.secretMissing])).toEqual([['g', true]])
    expect([...(await a.api.listSyncConflicts(ws, true)), ...(await b.api.listSyncConflicts(wsB, true))]).toEqual([])
    expect(pendingCount(b, wsB)).toBe(0)
    expect(liveState(a, ws)).toEqual(liveState(b, wsB))
    expect(pushedBodies()).not.toContain('SECRET-old')
  })

  it('a server downgrade stops pushing the new data again without errors', async () => {
    const p = await pair(async (a, _ws, s) => void (await a.api.setFolderScripts(s.folder, SCRIPT('x'))))
    cloud.extensions = false
    await p.a.api.setFolderScripts(p.s.folder, SCRIPT('y'))
    await p.a.api.upsertGlobalVariable({ workspaceId: p.wsA, key: 'g', value: '1', isSecret: false })
    cloud.clearRecorded()
    const s = await settle(p.a, p.wsA)
    expect(s).toMatchObject({ pendingChanges: 0, openConflicts: 0, lastError: null })
    expect(pushedBodies()).toBe('')
    expect(rows(p.a, "SELECT base_payload FROM sync_entities WHERE entity_type = 'folder'").map((r) => String(r.base_payload))).not.toContain('scripts_json')
  })
})
