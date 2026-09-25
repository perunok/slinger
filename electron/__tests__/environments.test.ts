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
