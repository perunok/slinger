/** "Extract to new collection" through the IPC API (validation + service + real SQLite). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeEnv, scaffold, type TestEnv } from './helpers'

let env: TestEnv
let ws: string
let colId: string
beforeEach(async () => {
  env = makeEnv()
  const s = await scaffold(env)
  ws = s.workspace.id
  colId = s.collection.id
})
afterEach(() => env.cleanup())

const scripts = (code: string) => JSON.stringify([{ listen: 'prerequest', script: { type: 'text/javascript', exec: [code] } }])

/** Col: Keep (request "stays"), Drive (scripts + docs) > [Create, Sub > [Deep > [Deepest], Get]] */
async function tree() {
  const api = env.api
  const keep = await api.createFolder({ workspaceId: ws, collectionId: colId, name: 'Keep' })
  const drive = await api.createFolder({ workspaceId: ws, collectionId: colId, name: 'Drive' })
  await api.setFolderScripts(drive.id, scripts('pm.variables.set("fromFolder", 1)'))
  await api.setFolderDescription(drive.id, '# Drive docs')
  const sub = await api.createFolder({ workspaceId: ws, collectionId: colId, parentFolderId: drive.id, name: 'Sub' })
  await api.setFolderScripts(sub.id, scripts('// sub'))
  const deep = await api.createFolder({ workspaceId: ws, collectionId: colId, parentFolderId: sub.id, name: 'Deep' })
  const req = (name: string, folderId: string) => api.createRequest({ workspaceId: ws, collectionId: colId, folderId, name, method: 'GET', url: `https://x/${name}`, documentJson: '{"note":"' + name + '"}' })
  const stays = await req('stays', keep.id)
  const create = await req('Create', drive.id)
  const get = await req('Get', sub.id)
  const deepest = await req('Deepest', deep.id)
  return { keep, drive, sub, deep, stays, create, get, deepest }
}

describe('extractFolderToCollection', () => {
  it('turns the folder into a collection: subfolders mirrored, requests moved with their ids, the old tree gone', async () => {
    const t = await tree()
    const r = await env.api.extractFolderToCollection({ folderId: t.drive.id, name: 'Drive Automation', copyCollectionVariables: false })
    expect(r).toMatchObject({ sourceCollectionId: colId, folderCount: 2, requestCount: 3, variableCount: 0 })
    expect(r.collection).toMatchObject({ name: 'Drive Automation', workspaceId: ws, scriptsJson: scripts('pm.variables.set("fromFolder", 1)'), description: '# Drive docs' })

    const folders = await env.api.listFolders(r.collection.id)
    const sub = folders.find((f) => f.name === 'Sub')!
    const deep = folders.find((f) => f.name === 'Deep')!
    expect(sub).toMatchObject({ parentFolderId: null, scriptsJson: scripts('// sub') })
    expect(deep.parentFolderId).toBe(sub.id)
    expect([sub.id, deep.id]).not.toContain(t.sub.id)

    const moved = await env.api.listRequests(r.collection.id)
    expect(moved.map((q) => [q.id, q.name, q.folderId]).sort()).toEqual(
      [
        [t.create.id, 'Create', null],
        [t.get.id, 'Get', sub.id],
        [t.deepest.id, 'Deepest', deep.id],
      ].sort(),
    )
    // Content travels untouched.
    expect(moved.find((q) => q.id === t.deepest.id)!.documentJson).toBe('{"note":"Deepest"}')

    // The source keeps everything else and loses the folder tree.
    expect((await env.api.listFolders(colId)).map((f) => f.name)).toEqual(['Keep'])
    expect((await env.api.listRequests(colId)).map((q) => q.name)).toEqual(['stays'])
    expect((await env.api.listCollections(ws)).map((c) => c.name).sort()).toEqual(['Col', 'Drive Automation'])
  })

  it('takes the scripts it is given (the merged chain) and copies the collection variables when asked', async () => {
    const t = await tree()
    await env.api.replaceCollectionVariables(colId, [
      { key: 'baseUrl', value: 'https://api.test', enabled: true },
      { key: 'old', value: 'x', enabled: false },
    ])
    const merged = scripts('// merged')
    const r = await env.api.extractFolderToCollection({ folderId: t.drive.id, name: 'D', scriptsJson: merged, copyCollectionVariables: true })
    expect(r.variableCount).toBe(2)
    expect(r.collection.scriptsJson).toBe(merged)
    const vars = await env.api.listCollectionVariables(r.collection.id)
    expect(vars.map((v) => [v.key, v.value, v.enabled])).toEqual([['baseUrl', 'https://api.test', true], ['old', 'x', false]])
    // The source keeps its own.
    expect(await env.api.listCollectionVariables(colId)).toHaveLength(2)
    // null means no scripts at all.
    const t2 = await env.api.createFolder({ workspaceId: ws, collectionId: colId, name: 'Plain' })
    await env.api.setFolderScripts(t2.id, scripts('// own'))
    const r2 = await env.api.extractFolderToCollection({ folderId: t2.id, name: 'P', scriptsJson: null, copyCollectionVariables: false })
    expect(r2.collection.scriptsJson).toBeNull()
  })

  it('an empty folder becomes an empty collection; bad input is refused', async () => {
    const empty = await env.api.createFolder({ workspaceId: ws, collectionId: colId, name: 'Empty' })
    const r = await env.api.extractFolderToCollection({ folderId: empty.id, name: 'Empty', copyCollectionVariables: true })
    expect(r).toMatchObject({ folderCount: 0, requestCount: 0, variableCount: 0 })
    await expect(env.api.extractFolderToCollection({ folderId: empty.id, name: 'Again', copyCollectionVariables: false })).rejects.toMatchObject({ code: 'not_found' })
    await expect(env.api.extractFolderToCollection({ folderId: 'nope', name: 'X', copyCollectionVariables: false })).rejects.toMatchObject({ code: 'invalid_input' })
    const f = await env.api.createFolder({ workspaceId: ws, collectionId: colId, name: 'F' })
    await expect(env.api.extractFolderToCollection({ folderId: f.id, name: '   ', copyCollectionVariables: false })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
