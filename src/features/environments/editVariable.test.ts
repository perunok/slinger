import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { scopeStore } from '../../app/scope.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { saveVariableValue } from './editVariable'

let backend: ReturnType<typeof createMockBackend>
let collectionId: string

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  await app.init()
  await app.setActiveEnvironment(app.environments.find((e) => e.name === 'Local')!.id)
  collectionId = app.collections[0]!.id
  await backend.upsertCollectionVariable({ collectionId, key: 'customer', value: 'WXcrkT', enabled: true })
  await backend.upsertGlobalVariable({ workspaceId: app.workspaceId!, key: 'region', value: 'eu', isSecret: false, enabled: true })
  await Promise.all([app.reloadCollectionVariables(collectionId), app.reloadGlobals()])
  scopeStore.collectionId = collectionId
})

const scope = () => scopeStore.scopeFor(collectionId)
const resolved = (name: string) => scope().variables.get(name)

describe('saveVariableValue', () => {
  it('writes an environment variable to the active environment and refreshes the placeholders', async () => {
    const v = resolved('baseUrl')!
    expect(v.source).toBe('environment')
    await saveVariableValue(v, 'https://changed.test', scope())
    const local = app.environments.find((e) => e.name === 'Local')!
    expect((await backend.listEnvironmentVariables(local.id)).find((x) => x.key === 'baseUrl')?.value).toBe('https://changed.test')
    await vi.waitFor(() => expect(resolved('baseUrl')?.value).toBe('https://changed.test'))
  })

  it('writes a collection variable to the collection, not to an environment', async () => {
    const v = resolved('customer')!
    expect(v.source).toBe('collection')
    await saveVariableValue(v, 'Acme Ltd', scope())
    expect((await backend.listCollectionVariables(collectionId)).find((x) => x.key === 'customer')).toMatchObject({ value: 'Acme Ltd', enabled: true })
    const local = app.environments.find((e) => e.name === 'Local')!
    expect((await backend.listEnvironmentVariables(local.id)).some((x) => x.key === 'customer')).toBe(false)
    await vi.waitFor(() => expect(resolved('customer')?.value).toBe('Acme Ltd'))
  })

  it('writes a global to the workspace globals', async () => {
    await saveVariableValue(resolved('region')!, 'us', scope())
    expect((await backend.listGlobalVariables(app.workspaceId!)).find((x) => x.key === 'region')?.value).toBe('us')
    await vi.waitFor(() => expect(resolved('region')?.value).toBe('us'))
  })

  it('keeps a secret secret', async () => {
    const local = app.environments.find((e) => e.name === 'Local')!
    await backend.upsertEnvironmentVariable({ environmentId: local.id, key: 'token', value: 'old', isSecret: true })
    await app.refreshEnvVariables()
    await saveVariableValue(resolved('token')!, 'sk-new', scope())
    const row = (await backend.listEnvironmentVariables(local.id)).find((x) => x.key === 'token')!
    expect(row.isSecret).toBe(true)
    expect(await backend.revealEnvironmentVariable(row.id)).toBe('sk-new')
  })

  it('refuses what has nowhere to be saved, with a readable message', async () => {
    await expect(saveVariableValue({ key: 'tmp', value: '1', secret: false, source: 'local', id: 'x' }, '2', scope())).rejects.toThrow(/pm.variables/)
    await expect(saveVariableValue({ key: 'tmp', value: '1', secret: false }, '2', scope())).rejects.toThrow(/not been saved/)
  })
})
