import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from './mockBackend'

let api: ReturnType<typeof createMockBackend>
beforeEach(() => {
  api = createMockBackend({ latencyMs: 0, seed: false })
})

describe('mock backend: persisted variables', () => {
  it('behaves like the main process for collection variables', async () => {
    const ws = await api.createWorkspace('W')
    const col = await api.createCollection(ws.id, 'C')
    const a = await api.upsertCollectionVariable({ collectionId: col.id, key: 'a', value: '1' })
    await api.upsertCollectionVariable({ collectionId: col.id, key: 'b', value: '2', enabled: false })
    await expect(api.upsertCollectionVariable({ collectionId: col.id, key: 'b', value: '3', variableId: a.id })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.upsertCollectionVariable({ collectionId: col.id, key: 's', value: '3', isSecret: true })).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await api.listCollectionVariables(col.id)).map((v) => [v.key, v.enabled, v.sortOrder])).toEqual([['a', true, 0], ['b', false, 1]])
    const out = await api.replaceCollectionVariables(col.id, [{ key: 'c', value: '3' }, { key: 'a', value: '1' }])
    expect(out.map((v) => v.key)).toEqual(['c', 'a'])
    expect(out[1]!.id).toBe(a.id)
    await api.deleteCollection(col.id)
    await expect(api.listCollectionVariables(col.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('masks secret globals and keeps them on empty upserts', async () => {
    const ws = await api.createWorkspace('W')
    const g = await api.upsertGlobalVariable({ workspaceId: ws.id, key: 't', value: 'secret', isSecret: true })
    expect(g).toMatchObject({ value: null, maskedValue: '••••••••' })
    await api.upsertGlobalVariable({ workspaceId: ws.id, key: 't', value: '', isSecret: true, variableId: g.id })
    expect(await api.revealGlobalVariable(g.id)).toBe('secret')
    await api.replaceGlobalVariables(ws.id, [{ key: 't', value: '', isSecret: true }])
    expect(await api.revealGlobalVariable(g.id)).toBe('secret')
  })
})
