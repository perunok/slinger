import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_GRAPH_JSON } from '../repositories/workflows'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
let workspaceId: string
const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args)

beforeEach(async () => {
  env = makeEnv()
  workspaceId = (await env.api.listWorkspaces())[0]!.id
})
afterEach(() => env.cleanup())

describe('workflows', () => {
  it('creates with an empty graph, lists by name without the graph, reads one with it', async () => {
    const b = await env.api.createWorkflow({ workspaceId, name: '  Beta flow ' })
    const a = await env.api.createWorkflow({ workspaceId, name: 'alpha', graphJson: '{"v":1,"nodes":[{"id":"n1"}],"edges":[]}' })
    expect(b).toMatchObject({ workspaceId, name: 'Beta flow', version: 1, graphJson: EMPTY_GRAPH_JSON })
    const list = await env.api.listWorkflows(workspaceId)
    expect(list.map((w) => w.name)).toEqual(['alpha', 'Beta flow'])
    expect(list[0]).not.toHaveProperty('graphJson')
    expect((await env.api.getWorkflow(a.id)).graphJson).toContain('"n1"')
  })

  it('updates with optimistic concurrency', async () => {
    const w = await env.api.createWorkflow({ workspaceId, name: 'Flow' })
    const v2 = await env.api.updateWorkflow({ workflowId: w.id, expectedVersion: 1, graphJson: '{"v":1,"nodes":[],"edges":[],"viewport":{"x":1,"y":2,"zoom":1}}' })
    expect(v2.version).toBe(2)
    expect(v2.name).toBe('Flow')
    const v3 = await env.api.updateWorkflow({ workflowId: w.id, expectedVersion: 2, name: 'Renamed' })
    expect(v3).toMatchObject({ version: 3, name: 'Renamed' })
    expect(v3.graphJson).toContain('viewport')
    await expect(env.api.updateWorkflow({ workflowId: w.id, expectedVersion: 2, name: 'Stale' })).rejects.toMatchObject({
      code: 'version_conflict',
      details: { expectedVersion: 2, currentVersion: 3 },
    })
  })

  it('duplicates and soft-deletes', async () => {
    const w = await env.api.createWorkflow({ workspaceId, name: 'Flow', graphJson: '{"v":1,"nodes":[{"id":"x"}],"edges":[]}' })
    const copy = await env.api.duplicateWorkflow(w.id)
    expect(copy).toMatchObject({ name: 'Flow copy', graphJson: w.graphJson })
    expect(copy.id).not.toBe(w.id)
    expect((await env.api.duplicateWorkflow(w.id, 'Other')).name).toBe('Other')
    await env.api.deleteWorkflow(w.id)
    await expect(env.api.getWorkflow(w.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(env.api.deleteWorkflow(w.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await env.api.listWorkflows(workspaceId)).map((x) => x.name)).toEqual(['Flow copy', 'Other'])
    const row = env.core.db.prepare('SELECT deleted, version FROM workflows WHERE id = ?').get(w.id)
    expect(row).toEqual({ deleted: 1, version: 2 })
  })

  it('goes with its workspace', async () => {
    const other = await env.api.createWorkspace('Other')
    const w = await env.api.createWorkflow({ workspaceId: other.id, name: 'Flow' })
    await env.api.deleteWorkspace(other.id)
    await expect(env.api.getWorkflow(w.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(env.api.listWorkflows(other.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('is local-only: nothing is captured for sync', async () => {
    await env.api.createWorkflow({ workspaceId, name: 'Flow' })
    const dirty = env.core.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty WHERE entity_type LIKE '%workflow%'").get() as { n: number }
    expect(dirty.n).toBe(0)
  })

  it('validates input', async () => {
    const w = await env.api.createWorkflow({ workspaceId, name: 'Flow' })
    for (const graphJson of ['[]', 'null', '"x"', '{nope', '42']) {
      await expect(env.api.createWorkflow({ workspaceId, name: 'x', graphJson }), graphJson).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(env.api.createWorkflow({ workspaceId, name: 'x', graphJson: `{"a":"${'x'.repeat(5 * 1024 * 1024)}"}` })).rejects.toMatchObject({ code: 'invalid_input' })
    for (const bad of [
      [{ workspaceId, name: '' }],
      [{ workspaceId, name: '   ' }],
      [{ workspaceId: 'nope', name: 'x' }],
      [{ workspaceId, name: 'x', extra: 1 }],
    ]) {
      await expect(call(env.api.createWorkflow, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    for (const bad of [
      [{ workflowId: w.id, expectedVersion: 0 }],
      [{ workflowId: w.id }],
      [{ workflowId: w.id, expectedVersion: 1, graphJson: 5 }],
    ]) {
      await expect(call(env.api.updateWorkflow, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(env.api.getWorkflow('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'not_found' })
  })
})
