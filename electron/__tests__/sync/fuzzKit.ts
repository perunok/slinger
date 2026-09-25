/** Seeded random operations and random conflict resolution shared by the fake-server and real-server convergence tests. */
import type { Device } from './harness'
import { DOC } from './harness'

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rows = <T = Record<string, string | number | null>>(d: Device, sql: string, ...args: unknown[]) => d.db.prepare(sql).all(...args) as T[]

export async function randomOp(d: Device, ws: string, rnd: () => number, n: number): Promise<void> {
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

export async function resolveAll(d: Device, ws: string, rnd: () => number): Promise<number> {
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

