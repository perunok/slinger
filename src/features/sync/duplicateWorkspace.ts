/**
 * "Publish a copy": entity ids are globally unique on the server, so a workspace whose ids already live in
 * another cloud workspace cannot be published again. This makes a fresh-id copy through the ordinary IPC
 * methods (a new local workspace with new ids), which can then be published. Secret values are copied on this
 * device only; collection versions are not copied.
 */
import type { Workspace } from '../../../shared/types'
import { api } from '../../lib/ipc'

export interface CopyProgress {
  done: number
  total: number
}

const bySort = <T extends { sortOrder: number; id: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1)

export async function duplicateWorkspace(sourceId: string, name: string, onProgress?: (p: CopyProgress) => void): Promise<Workspace> {
  const [collections, environments] = await Promise.all([api().listCollections(sourceId), api().listEnvironments(sourceId)])
  const contents = await Promise.all(collections.map(async (c) => ({ c, folders: await api().listFolders(c.id), requests: await api().listRequests(c.id) })))
  const varsByEnv = await Promise.all(environments.map(async (e) => ({ e, vars: await api().listEnvironmentVariables(e.id) })))
  const total =
    1 + contents.reduce((n, x) => n + 1 + x.folders.length + x.requests.length, 0) + varsByEnv.reduce((n, x) => n + 1 + x.vars.length, 0)
  let done = 0
  const step = () => onProgress?.({ done: ++done, total })

  const ws = await api().createWorkspace(name)
  step()

  // Names are unique per workspace; only sync can leave two same-named environments in the source, so number the copies.
  const usedNames = new Set<string>()
  for (const { e, vars } of varsByEnv) {
    let envName = e.name
    for (let i = 2; usedNames.has(envName.trim().toLowerCase()); i++) envName = `${e.name} (${i})`
    usedNames.add(envName.trim().toLowerCase())
    const env = await api().createEnvironment(ws.id, envName)
    step()
    for (const v of vars) {
      let value = v.value ?? ''
      if (v.isSecret) {
        try {
          value = v.secretMissing ? '' : await api().revealEnvironmentVariable(v.id)
        } catch {
          value = ''
        }
      }
      await api().upsertEnvironmentVariable({ environmentId: env.id, key: v.key, value, isSecret: v.isSecret })
      step()
    }
  }

  for (const { c, folders, requests } of contents) {
    const col = await api().createCollection(ws.id, c.name)
    step()
    const folderMap = new Map<string, string>()
    // Parents before children, siblings in their stored order.
    const queue = folders.filter((f) => f.parentFolderId === null).sort(bySort)
    while (queue.length > 0) {
      const f = queue.shift()!
      const created = await api().createFolder({ workspaceId: ws.id, collectionId: col.id, parentFolderId: f.parentFolderId ? (folderMap.get(f.parentFolderId) ?? null) : null, name: f.name })
      folderMap.set(f.id, created.id)
      step()
      queue.push(...folders.filter((x) => x.parentFolderId === f.id).sort(bySort))
    }
    for (const r of [...requests].sort(bySort)) {
      await api().createRequest({
        workspaceId: ws.id,
        collectionId: col.id,
        folderId: r.folderId ? (folderMap.get(r.folderId) ?? null) : null,
        name: r.name,
        method: r.method,
        url: r.url,
        documentJson: r.documentJson,
      })
      step()
    }
  }
  return ws
}

/** Does this failure/message mean "an id is already used by another cloud workspace"? */
export function isIdInUse(message: string | null | undefined): boolean {
  return !!message && /id is already used|id in use|already used by another cloud workspace/i.test(message)
}
