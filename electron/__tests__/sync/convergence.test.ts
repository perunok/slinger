/**
 * Two-device convergence: a seeded, deterministic fuzzer (SEED=<n> to reproduce one seed) plus fixed scenarios.
 * Both devices work "offline" with random operations, sync in random order, random-resolve conflicts, and must
 * end with identical content that also equals the server's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SyncConflict } from '../../../shared/types'
import { canonicalJson } from '../../sync/mapping'
import { FakeCloud } from './fakeCloud'
import { DOC, converge, liveState, makePair, pendingCount, type Device, type Pair } from './harness'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let cloud: FakeCloud
let pairs: Pair[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  pairs = []
})
afterEach(async () => {
  for (const p of pairs) {
    p.a.cleanup()
    p.b.cleanup()
  }
  await cloud.stop()
})

const rows = <T = Record<string, string | number | null>>(d: Device, sql: string, ...args: unknown[]) => d.db.prepare(sql).all(...args) as T[]

async function randomOp(d: Device, ws: string, rnd: () => number, n: number): Promise<void> {
  const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(rnd() * xs.length)]
  const collections = rows<{ id: string }>(d, 'SELECT id FROM collections WHERE workspace_id = ? AND deleted = 0', ws)
  const folders = rows<{ id: string; collection_id: string }>(d, 'SELECT id, collection_id FROM folders WHERE workspace_id = ? AND deleted = 0', ws)
  const requests = rows<{ id: string; collection_id: string; version: number }>(d, 'SELECT id, collection_id, version FROM requests WHERE workspace_id = ? AND deleted = 0', ws)
  const envs = rows<{ id: string }>(d, 'SELECT id FROM environments WHERE workspace_id = ? AND deleted = 0', ws)
  const vars = rows<{ id: string; environment_id: string; key: string; is_secret: number }>(d, 'SELECT v.id, v.environment_id, v.key, v.is_secret FROM environment_variables v JOIN environments e ON e.id = v.environment_id WHERE e.workspace_id = ? AND v.deleted = 0 AND e.deleted = 0', ws)
  const versions = rows<{ id: string; collection_id: string }>(d, 'SELECT id, collection_id FROM collection_versions WHERE workspace_id = ? AND deleted = 0', ws)
  const r = rnd()
  const c = pick(collections)
  try {
    if (!c || r < 0.04) await d.api.createCollection(ws, `Col ${n}`)
    else if (r < 0.14) await d.api.createFolder({ workspaceId: ws, collectionId: c.id, parentFolderId: pick(folders.filter((f) => f.collection_id === c.id))?.id ?? null, name: `Folder ${n}` })
    else if (r < 0.3) await d.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: pick(folders.filter((f) => f.collection_id === c.id))?.id ?? null, name: `Req ${n}`, method: pick(['GET', 'POST', 'PUT'])!, url: `https://x/${n}`, documentJson: JSON.stringify({ headers: [], body: `b${n}` }) })
    else if (r < 0.4) { const x = pick(requests); if (x) await d.api.renameRequest(x.id, `Renamed ${n}`) }
    else if (r < 0.47) { const x = pick(requests); if (x) await d.api.updateRequest({ requestId: x.id, name: `Edited ${n}`, method: 'PATCH', url: `https://y/${n}`, documentJson: DOC, expectedVersion: x.version }) }
    else if (r < 0.57) {
      const x = pick(requests); const target = pick(collections)
      if (x && target) await d.api.moveRequest({ requestId: x.id, targetCollectionId: target.id, targetFolderId: pick(folders.filter((f) => f.collection_id === target.id))?.id ?? null, targetIndex: Math.floor(rnd() * 3) })
    } else if (r < 0.63) {
      const x = pick(folders)
      if (x) await d.api.moveFolder({ folderId: x.id, targetParentFolderId: pick(folders.filter((f) => f.collection_id === x.collection_id))?.id ?? null, targetIndex: Math.floor(rnd() * 3) })
    } else if (r < 0.68) { const x = pick(folders); if (x) await d.api.renameFolder(x.id, `Fold ${n}`) }
    else if (r < 0.72) { const x = pick(folders); if (x) await d.api.deleteFolder(x.id) }
    else if (r < 0.76) { const x = pick(requests); if (x) await d.api.deleteRequest(x.id) }
    else if (r < 0.77) { if (collections.length > 2) await d.api.deleteCollection(c.id) }
    else if (r < 0.8) await d.api.renameCollection(c.id, `Colr ${n}`)
    else if (r < 0.84) { const v = await d.api.createCollectionVersion({ collectionId: c.id, version: `1.${Math.floor(rnd() * 3)}.0` }); void v }
    else if (r < 0.87) { const v = pick(versions); if (v) await d.api.restoreCollectionVersion(v.id, rnd() < 0.5 ? 'replace' : 'copy') }
    else if (r < 0.89) await d.api.createEnvironment(ws, `Env ${n}`)
    else if (r < 0.92) { const e = pick(envs); const secret = rnd() < 0.3; if (e) await d.api.upsertEnvironmentVariable({ environmentId: e.id, key: `k${Math.floor(rnd() * 4)}`, value: secret ? `SECRET-${n}` : `val${n}`, isSecret: secret }) }
    else if (r < 0.95) { const v = pick(vars); const secret = rnd() < 0.5; if (v) await d.api.upsertEnvironmentVariable({ environmentId: v.environment_id, variableId: v.id, key: `k${Math.floor(rnd() * 4)}`, value: secret ? `SECRET-${n}` : `val${n}`, isSecret: secret }) }
    else if (r < 0.97) { const v = pick(vars); if (v) await d.api.deleteEnvironmentVariable(v.id) }
    else if (r < 0.985) { const e = pick(envs); if (e) await d.api.renameEnvironment(e.id, `EnvR ${n}`) }
    else { const e = pick(envs); if (e && envs.length > 1) await d.api.deleteEnvironment(e.id) }
  } catch (err) {
    // Invalid operations for the current state (cycles, duplicates, ...) are simply skipped.
    const code = (err as { code?: string }).code
    if (code && !['invalid_input', 'not_found', 'version_conflict'].includes(code) && !/UNIQUE|constraint/i.test(String((err as Error).message))) throw err
  }
}

async function resolveAll(d: Device, ws: string, rnd: () => number): Promise<number> {
  const open = await d.api.listSyncConflicts(ws)
  let n = 0
  for (const c of open) {
    const allowed = c.allowedResolutions
    if (!allowed.length) continue
    const resolution = allowed[Math.floor(rnd() * allowed.length)]!
    const fieldChoices = Object.fromEntries(c.groups.filter((g) => g.conflicting).map((g) => [g.group, rnd() < 0.5 ? 'local' : 'remote']))
    try {
      await d.api.resolveSyncConflict({ conflictId: c.id, resolution, fieldChoices, newVersion: `9.${Math.floor(rnd() * 1000)}.${n}` })
      n++
    } catch (err) {
      if ((err as { code?: string }).code !== 'invalid_input' && (err as { code?: string }).code !== 'not_found') throw err
    }
  }
  return n
}

async function quiesce(p: Pair, rnd: () => number): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await converge(p, 2)
    const n = (await resolveAll(p.a, p.wsA, rnd)) + (await resolveAll(p.b, p.wsB, rnd))
    const sa = await p.a.api.getSyncStatus(p.wsA)
    const sb = await p.b.api.getSyncStatus(p.wsB)
    if (n === 0 && sa.pendingChanges === 0 && sb.pendingChanges === 0 && sa.openConflicts === 0 && sb.openConflicts === 0) return
  }
}

function checkInvariants(p: Pair): void {
  const a = liveState(p.a, p.wsA)
  const b = liveState(p.b, p.wsB)
  const norm = (xs: Array<{ type: string; id: string; wire: unknown }>) => xs.map((x) => `${x.type}:${x.id}:${canonicalJson(x.wire)}`).sort()
  const diff = (x: string[], y: string[]) => x.filter((v) => !new Set(y).has(v))
  const server = cloud.live(p.remoteId).map((e) => ({ type: e.type, id: e.id, wire: cloud.wireOf(e) }))
  const [na, nb, ns] = [norm(a), norm(b), norm(server)]
  if (process.env.DUMP) {
    const bad = new Set([...diff(na, nb), ...diff(nb, na), ...diff(na, ns), ...diff(ns, na)].map((s) => s.split(':')[1]!))
    for (const id of bad) console.log(`--- ${id}\n${dumpEntity(p, id)}`)
  }
  expect(diff(na, nb), 'only on A (not equal on B)').toEqual([]) // (1) identical live sets, payloads and orders
  expect(diff(nb, na), 'only on B (not equal on A)').toEqual([])
  expect(diff(na, ns), 'on devices, not on/equal to server').toEqual([]) // (2) the server holds exactly that
  expect(diff(ns, na), 'on server, not on/equal to devices').toEqual([])
  // (3) structure
  const ids = new Map(a.map((x) => [`${x.type}:${x.id}`, x.wire as Record<string, unknown>]))
  const has = (t: string, id: unknown) => ids.has(`${t}:${String(id)}`)
  const keys = new Set<string>()
  const labels = new Set<string>()
  for (const x of a) {
    const w = x.wire as Record<string, unknown>
    if (x.type === 'folder') {
      expect(has('collection', w.collection_id), `folder ${x.id} collection`).toBe(true)
      if (w.parent_folder_id) {
        expect(has('folder', w.parent_folder_id)).toBe(true)
        expect((ids.get(`folder:${String(w.parent_folder_id)}`) as Record<string, unknown>).collection_id).toBe(w.collection_id)
      }
      const seen = new Set<string>([x.id])
      let cur = w.parent_folder_id as string | null
      while (cur) {
        expect(seen.has(cur), 'folder cycle').toBe(false)
        seen.add(cur)
        cur = (ids.get(`folder:${cur}`)?.parent_folder_id as string | null) ?? null
      }
    }
    if (x.type === 'request') {
      expect(has('collection', w.collection_id), `request ${x.id} collection`).toBe(true)
      if (w.folder_id) expect((ids.get(`folder:${String(w.folder_id)}`) as Record<string, unknown> | undefined)?.collection_id).toBe(w.collection_id)
    }
    if (x.type === 'environment_variable') {
      expect(has('environment', w.environment_id), `variable ${x.id} env`).toBe(true)
      const k = `${String(w.environment_id)}:${String(w.key)}`
      expect(keys.has(k), `duplicate key ${k}`).toBe(false)
      keys.add(k)
    }
    if (x.type === 'collection_version') {
      expect(has('collection', w.collection_id)).toBe(true)
      const k = `${String(w.collection_id)}:${String(w.semver)}`
      expect(labels.has(k), `duplicate version ${k}`).toBe(false)
      labels.add(k)
    }
  }
  // (4) secrets never crossed the wire
  expect(JSON.stringify(cloud.requests.map((r) => r.body))).not.toContain('SECRET-')
  // (6) nothing pending
  expect(pendingCount(p.a, p.wsA)).toBe(0)
  expect(pendingCount(p.b, p.wsB)).toBe(0)
}

async function seededPair(): Promise<Pair> {
  const p = await makePair(cloud, async (a, ws) => {
    for (let i = 0; i < 2; i++) {
      const c = await a.api.createCollection(ws, `Seed ${i}`)
      const f = await a.api.createFolder({ workspaceId: ws, collectionId: c.id, name: `SF ${i}` })
      await a.api.createFolder({ workspaceId: ws, collectionId: c.id, parentFolderId: f.id, name: `SFS ${i}` })
      for (let j = 0; j < 3; j++) await a.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: j === 0 ? null : f.id, name: `SR ${i}.${j}`, method: 'GET', url: `https://s/${i}/${j}`, documentJson: DOC })
    }
    const e = await a.api.createEnvironment(ws, 'Seed env')
    await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'k0', value: 'v', isSecret: false })
    await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'k1', value: 'SECRET-seed', isSecret: true })
  })
  pairs.push(p)
  return p
}

const seedCount = Number(process.env.SEEDS ?? 20) // SEEDS=200 explores more, SEED=<n> reproduces one
const seedFrom = Number(process.env.SEED_FROM ?? 1)
const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: seedCount }, (_, i) => seedFrom + i)

describe('two-device convergence fuzzer', () => {
  for (const seed of seeds) {
    it(`seed ${seed} converges to identical content that equals the server`, async () => {
      const rnd = mulberry32(seed)
      const p = await seededPair()
      let n = 0
      for (let round = 0; round < 5; round++) {
        for (const [d, ws] of [[p.a, p.wsA], [p.b, p.wsB]] as const) {
          const k = 2 + Math.floor(rnd() * 5)
          for (let i = 0; i < k; i++) await randomOp(d, ws, rnd, ++n)
        }
        // sync in random order, sometimes only one device
        const mode = rnd()
        if (mode < 0.35) { await p.a.core.sync.syncNow(p.wsA); await p.b.core.sync.syncNow(p.wsB) }
        else if (mode < 0.7) { await p.b.core.sync.syncNow(p.wsB); await p.a.core.sync.syncNow(p.wsA) }
        else if (mode < 0.85) await p.a.core.sync.syncNow(p.wsA)
      }
      await quiesce(p, rnd)
      checkInvariants(p)
    })
  }
})

describe('fixed convergence scenarios', () => {
  it('an entity edited only on A converges to A\'s value on B', async () => {
    const p = await seededPair()
    const req = rows<{ id: string }>(p.a, "SELECT id FROM requests WHERE name = 'SR 0.1'")[0]!
    await p.a.api.renameRequest(req.id, 'Only A touched me')
    await converge(p)
    expect(rows<{ name: string }>(p.b, 'SELECT name FROM requests WHERE id = ?', req.id)).toEqual([{ name: 'Only A touched me' }])
    checkInvariants(p)
  })

  it('same-label collection versions created on both devices: immutable_clash, resolvable by duplicating', async () => {
    const p = await seededPair()
    const col = rows<{ id: string }>(p.a, "SELECT id FROM collections WHERE name = 'Seed 0'")[0]!
    await p.a.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'from A' })
    await p.b.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'from B' })
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    const open: SyncConflict[] = await p.b.api.listSyncConflicts(p.wsB)
    expect(open.map((c) => c.kind)).toEqual(['immutable_clash'])
    expect(open[0]!.allowedResolutions).toEqual(['keep_remote', 'duplicate'])
    await p.b.api.resolveSyncConflict({ conflictId: open[0]!.id, resolution: 'duplicate', newVersion: '1.0.1' })
    await converge(p)
    for (const d of [p.a, p.b]) {
      const vs = (await d.api.listCollectionVersions(col.id)).map((v) => v.version).sort()
      expect(vs).toEqual(['1.0.0', '1.0.1'])
    }
    checkInvariants(p)
  })

  it('deleting a big folder on one device while the other adds a request inside never loses the new request silently', async () => {
    const p = await seededPair()
    const folder = rows<{ id: string; collection_id: string }>(p.a, "SELECT id, collection_id FROM folders WHERE name = 'SF 0'")[0]!
    await p.a.api.createRequest({ workspaceId: p.wsA, collectionId: folder.collection_id, folderId: folder.id, name: 'Late add', method: 'GET', url: 'u', documentJson: DOC })
    await p.b.api.deleteFolder(folder.id)
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
    expect(await p.b.api.listSyncConflicts(p.wsB)).not.toEqual([])
    const rnd = mulberry32(7)
    await quiesce(p, rnd)
    checkInvariants(p)
  })

  it('restore (replace and copy) and imports converge', async () => {
    const p = await seededPair()
    const col = rows<{ id: string }>(p.a, "SELECT id FROM collections WHERE name = 'Seed 1'")[0]!
    const v = await p.a.api.createCollectionVersion({ collectionId: col.id, version: '2.0.0' })
    await converge(p)
    await p.a.api.restoreCollectionVersion(v.id, 'replace')
    await p.b.api.restoreCollectionVersion(v.id, 'copy')
    await p.b.api.importPostmanCollection(p.wsB, JSON.stringify({ info: { name: 'Imp', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'F', item: [{ name: 'One', request: { method: 'GET', url: 'https://a' } }] }] }))
    await quiesce(p, mulberry32(3))
    checkInvariants(p)
  })
})

/** Debug aid: with `DUMP=1` every diverging entity is printed (both devices' rows, bookkeeping, server log). */
function dumpEntity(p: Pair, id: string): string {
  const one = (name: string, d: Device) =>
    JSON.stringify({
      name,
      rows: ['collections', 'folders', 'requests', 'environments', 'environment_variables', 'collection_versions'].flatMap((t) => rows(d, `SELECT * FROM ${t} WHERE id = ?`, id)).map((r) => ({ ...r, document_json: undefined, snapshot_json: undefined })),
      entity: rows(d, 'SELECT * FROM sync_entities WHERE entity_id = ?', id),
      dirty: rows(d, 'SELECT * FROM sync_dirty WHERE entity_id = ?', id),
      conflicts: rows(d, 'SELECT id, kind, status, resolution FROM sync_conflicts WHERE entity_id = ?', id),
    })
  const trace = cloud.requests.filter((r) => /sync\/push$/.test(r.path) && r.body.includes(id)).map((r) => {
    const ops = (JSON.parse(r.body).operations as Array<{ resource_id: string; op: string; base_version: number; operation_id: string; payload: unknown }>).filter((o) => o.resource_id === id)
    const resp = JSON.parse(r.response ?? '{}') as { accepted?: Array<{ resource_id: string }>; rejected?: Array<{ resource_id: string; code: string }> }
    return JSON.stringify({ push: ops.map((o) => `${o.op}@${o.base_version}`), accepted: resp.accepted?.filter((x) => x.resource_id === id).length, rejected: resp.rejected?.filter((x) => x.resource_id === id).map((x) => x.code) })
  })
  return [one('A', p.a), one('B', p.b), trace.join('\n'), JSON.stringify({ server: cloud.entity(id), log: cloud.workspaces.get(p.remoteId)!.log.filter((o) => o.resource_id === id).map((o) => ({ op: o.op, v: o.resulting_version, cp: o.checkpoint, payload: o.payload })) })].join('\n')
}
