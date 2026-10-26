import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

const duplicate = (name: string) => ({
  code: 'invalid_input',
  message: `An environment named "${name}" already exists.`,
  details: { reason: 'duplicate_name' },
})

describe('environment names are unique per workspace', () => {
  it('create rejects a live name clash, ignoring case and surrounding whitespace', async () => {
    const ws = await env.api.createWorkspace('WS')
    await env.api.createEnvironment(ws.id, 'enat uat')
    await expect(env.api.createEnvironment(ws.id, 'enat uat')).rejects.toMatchObject(duplicate('enat uat'))
    await expect(env.api.createEnvironment(ws.id, '  ENAT UAT ')).rejects.toMatchObject(duplicate('enat uat'))
    expect((await env.api.listEnvironments(ws.id)).map((e) => e.name)).toEqual(['enat uat'])
  })

  it('rename rejects another environment’s name but allows a case change of its own name', async () => {
    const ws = await env.api.createWorkspace('WS')
    const a = await env.api.createEnvironment(ws.id, 'Prod')
    const b = await env.api.createEnvironment(ws.id, 'Staging')
    await expect(env.api.renameEnvironment(b.id, ' prod')).rejects.toMatchObject(duplicate('Prod'))
    expect((await env.api.renameEnvironment(a.id, 'PROD')).name).toBe('PROD')
    expect((await env.api.renameEnvironment(a.id, 'PROD')).name).toBe('PROD')
    expect((await env.api.renameEnvironment(b.id, 'QA')).name).toBe('QA')
  })

  it('deleted environments and other workspaces do not count', async () => {
    const ws = await env.api.createWorkspace('WS')
    const other = await env.api.createWorkspace('Other')
    const gone = await env.api.createEnvironment(ws.id, 'Prod')
    await env.api.deleteEnvironment(gone.id)
    const again = await env.api.createEnvironment(ws.id, 'prod')
    expect(again.name).toBe('prod')
    expect((await env.api.createEnvironment(other.id, 'Prod')).name).toBe('Prod')
    const x = await env.api.createEnvironment(ws.id, 'X')
    await env.api.deleteEnvironment(again.id)
    expect((await env.api.renameEnvironment(x.id, 'PROD')).name).toBe('PROD')
  })
})

describe('environment variable writes use optimistic concurrency', () => {
  async function setup() {
    const ws = await env.api.createWorkspace('WS')
    const e = await env.api.createEnvironment(ws.id, 'Dev')
    return e
  }

  it('updates with the current expectedVersion and rejects a stale one', async () => {
    const e = await setup()
    const v1 = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'host', value: 'a', isSecret: false })
    const v2 = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'host', value: 'b', isSecret: false, variableId: v1.id, expectedVersion: v1.version })
    expect(v2.version).toBe(v1.version + 1)
    await expect(
      env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'host', value: 'c', isSecret: false, variableId: v1.id, expectedVersion: v1.version }),
    ).rejects.toMatchObject({ code: 'version_conflict', details: { expectedVersion: v1.version, currentVersion: v2.version } })
    expect((await env.api.listEnvironmentVariables(e.id)).map((v) => v.value)).toEqual(['b'])
    // Without expectedVersion (scripts, assistants) the write still goes through.
    const v3 = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'host', value: 'd', isSecret: false, variableId: v1.id })
    expect(v3.value).toBe('d')
  })

  it('a stale secret write leaves the keychain untouched', async () => {
    const e = await setup()
    const v1 = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'token', value: 'one', isSecret: true })
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'token', value: 'two', isSecret: true, variableId: v1.id, expectedVersion: v1.version })
    await expect(
      env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'token', value: 'three', isSecret: true, variableId: v1.id, expectedVersion: v1.version }),
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await env.api.revealEnvironmentVariable(v1.id)).toBe('two')
  })

  it('a keychain failure rolls the row back', async () => {
    const e = await setup()
    const v1 = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'token', value: 'plain', isSecret: false })
    const set = env.secrets.set.bind(env.secrets)
    env.secrets.set = () => {
      throw new Error('keyring locked')
    }
    try {
      await expect(
        env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'token', value: 's3cret', isSecret: true, variableId: v1.id, expectedVersion: v1.version }),
      ).rejects.toThrow()
    } finally {
      env.secrets.set = set
    }
    const [row] = await env.api.listEnvironmentVariables(e.id)
    expect(row).toMatchObject({ isSecret: false, value: 'plain', version: v1.version })
  })
})
