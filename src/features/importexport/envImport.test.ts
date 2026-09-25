import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '../../dev/mockBackend'
import { dedupeVars, describeEnvImport, importIntoEnvironment, planMerge, type ImportVar } from './envImport'

let api: ReturnType<typeof createMockBackend>
let ws: string
beforeEach(async () => {
  api = createMockBackend({ latencyMs: 0, seed: false })
  ws = (await api.createWorkspace('W')).id
})

const plain = (key: string, value: string): ImportVar => ({ key, value, secret: false })
const secret = (key: string, value: string): ImportVar => ({ key, value, secret: true })

async function varsOf(name: string) {
  const env = (await api.listEnvironments(ws)).find((e) => e.name.toLowerCase() === name.toLowerCase())!
  const vars = await api.listEnvironmentVariables(env.id)
  const out: Record<string, { value: string; secret: boolean }> = {}
  for (const v of vars) out[v.key] = { value: v.isSecret ? await api.revealEnvironmentVariable(v.id) : (v.value ?? ''), secret: v.isSecret }
  return out
}

describe('planMerge / dedupeVars', () => {
  it('drops blank keys and keeps the last duplicate', () => {
    expect(dedupeVars([plain('a', '1'), plain(' ', 'x'), plain('a ', '2')])).toEqual([plain('a', '2')])
  })
  it('keep mode only adds new keys', () => {
    const existing = [{ id: 'v1', environmentId: 'e', key: 'a', value: 'mine', isSecret: false, maskedValue: null, secretMissing: false, createdAt: 0, updatedAt: 0, version: 1 }]
    expect(planMerge(existing, [plain('a', 'theirs'), plain('b', '2')], 'keep')).toEqual({ add: [plain('b', '2')], update: [], kept: 1 })
  })
})

describe('importIntoEnvironment', () => {
  it('creates the environment when missing', async () => {
    const r = await importIntoEnvironment(api, ws, 'enat uat', [plain('host', 'h'), secret('pw', 'p')], 'keep')
    expect(r).toMatchObject({ created: true, added: 2, updated: 0, kept: 0 })
    expect(describeEnvImport(r)).toBe('Environment "enat uat" created with 2 variables')
    expect(await varsOf('enat uat')).toEqual({ host: { value: 'h', secret: false }, pw: { value: 'p', secret: true } })
  })

  it('collection variables merge into a same-named environment: new keys added, existing values kept', async () => {
    const env = await api.createEnvironment(ws, 'Enat UAT')
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 'set-by-script', isSecret: false })
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'host', value: 'edited', isSecret: false })
    const r = await importIntoEnvironment(api, ws, ' enat uat ', [plain('host', 'orig'), plain('token', ''), plain('baseUrl', 'b')], 'keep')
    expect(r).toMatchObject({ created: false, environmentId: env.id, added: 1, updated: 0, kept: 2 })
    expect(describeEnvImport(r)).toBe('Environment "Enat UAT" updated: 1 added, 2 kept')
    expect(await api.listEnvironments(ws)).toHaveLength(1)
    expect(await varsOf('Enat UAT')).toEqual({
      baseUrl: { value: 'b', secret: false },
      host: { value: 'edited', secret: false },
      token: { value: 'set-by-script', secret: false },
    })
  })

  it('environment files overwrite values and secret flags; an empty secret keeps the stored one', async () => {
    const env = await api.createEnvironment(ws, 'Prod')
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'host', value: 'old', isSecret: false })
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'apiKey', value: 'stored-secret', isSecret: true })
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'user', value: 'u', isSecret: false })
    await api.upsertEnvironmentVariable({ environmentId: env.id, key: 'local', value: 'only here', isSecret: false })
    const file = [plain('host', 'new'), secret('apiKey', ''), secret('user', 'now-secret'), plain('extra', 'x')]
    const r = await importIntoEnvironment(api, ws, 'prod', file, 'overwrite')
    expect(r).toMatchObject({ created: false, added: 1, updated: 2, kept: 1 })
    expect(describeEnvImport(r)).toBe('Environment "Prod" updated: 1 added, 2 updated, 1 kept')
    expect(await varsOf('Prod')).toEqual({
      apiKey: { value: 'stored-secret', secret: true },
      extra: { value: 'x', secret: false },
      host: { value: 'new', secret: false },
      local: { value: 'only here', secret: false },
      user: { value: 'now-secret', secret: true },
    })
  })

  it('a second import of the same file creates nothing new', async () => {
    const file = [plain('host', 'h'), plain('port', '8080'), secret('pw', 'p')]
    await importIntoEnvironment(api, ws, 'Staging', file, 'overwrite')
    const before = await varsOf('Staging')
    const r = await importIntoEnvironment(api, ws, 'Staging', file, 'overwrite')
    expect(r).toMatchObject({ created: false, added: 0, kept: 2, updated: 1 }) // the secret is rewritten (value unknown to the renderer)
    expect(await api.listEnvironments(ws)).toHaveLength(1)
    expect(await varsOf('Staging')).toEqual(before)
    const again = await importIntoEnvironment(api, ws, 'staging', file, 'keep')
    expect(again).toMatchObject({ created: false, added: 0, updated: 0, kept: 3 })
  })

  it('creates a secret without a value as a plain empty variable (a secret needs a value)', async () => {
    const r = await importIntoEnvironment(api, ws, 'E', [secret('pw', '')], 'overwrite')
    expect(r).toMatchObject({ created: true, added: 1 })
    expect(await varsOf('E')).toEqual({ pw: { value: '', secret: false } })
  })
})
