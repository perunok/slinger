/**
 * Workflows in the real app: built on the canvas (click-to-add chains from the selected node, the request picker),
 * run against a local server with the QuickJS sandbox evaluating the JavaScript nodes, restored after a reload, deleted.
 * Steps share one app instance and run in order.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, reloadApp, type Launched } from './support/app'

let tmp: string
let server: Server
let base: string
const hits: string[] = []
let ctx: Launched
let ids: { list: string; user: string }

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-workflows-'))
  server = createServer((req, res) => {
    hits.push(`${req.url} ${req.headers.authorization ?? '-'}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    const m = /^\/users\/(\d+)$/.exec(req.url ?? '')
    res.end(JSON.stringify(m ? { id: Number(m[1]), name: `User ${m[1]}` } : { token: 'tok-9', users: [{ id: 1 }, { id: 2 }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ctx = await launch(join(tmp, 'profile'), { SLINGER_INSECURE_TEST_KEYCHAIN: '1' })
  ids = await ctx.page.evaluate(async (base) => {
    const s = window.slinger
    const ws = (await s.listWorkspaces())[0]!
    const col = await s.createCollection(ws.id, 'Users API')
    const doc = (url: string, auth = false) =>
      JSON.stringify({ method: 'GET', url, headers: auth ? [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }] : [] })
    const list = await s.createRequest({ workspaceId: ws.id, collectionId: col.id, name: 'List users', method: 'GET', url: `${base}/users`, documentJson: doc(`${base}/users`) })
    const user = await s.createRequest({ workspaceId: ws.id, collectionId: col.id, name: 'Get user', method: 'GET', url: `${base}/users/{{id}}`, documentJson: doc(`${base}/users/{{id}}`, true) })
    return { list: list.id, user: user.id }
  }, base)
  await reloadApp(ctx.page)
})

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

const node = (id: string) => ctx.page.locator(`.svelte-flow__node[data-id="${id}"]`)
const status = () => ctx.page.getByTestId('wf-status')

describe('workflows', () => {
  it('builds a workflow on the canvas and runs it', async () => {
    const { page } = ctx
    await page.getByRole('tab', { name: 'Workflows' }).click()
    await page.getByRole('button', { name: 'New workflow' }).first().click()
    await page.getByRole('dialog').getByRole('textbox').fill('List and show')
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
    await page.locator('.svelte-flow__node[data-id] [data-node-type="start"]').waitFor()

    // Select Start, then click palette items: each is added after the selected node and connected to it.
    await page.locator('[data-node-type="start"]').click()
    await page.getByRole('button', { name: 'Add Send request' }).click()
    await page.locator('[aria-label="Node settings"] select').selectOption(ids.list)
    await page.getByRole('button', { name: 'Add Output' }).click()
    await expect.poll(() => page.locator('.svelte-flow__edge').count()).toBe(2)

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await status().filter({ hasText: 'Done in 3 steps' }).waitFor()
    await expect(page.locator('[data-node-type="output"] pre').innerText()).resolves.toContain('"token":"tok-9"')
    expect(hits).toEqual(['/users -'])
    await expect(page.getByTestId('wf-save-state').innerText()).resolves.toBe('Saved')
  })

  it('runs loops, sandboxed JavaScript and run variables', async () => {
    const { page } = ctx
    const workflowId = await page.evaluate(async (ids) => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]!
      const n = (id: string, type: string, x: number, y: number, config: unknown) => ({ id, type, position: { x, y }, config })
      const nodes = [
        n('start', 'start', 0, 100, { value: '' }),
        n('list', 'request', 280, 100, { requestId: ids.list }),
        n('tok', 'setVariable', 560, 100, { name: 'token', value: 'input.body.token', scope: 'run' }),
        n('each', 'forEach', 840, 100, { list: 'input.body.users' }),
        n('shape', 'evaluate', 1120, 0, { code: "const _ = require('lodash')\nreturn { id: _.get(input, 'id') }" }),
        n('get', 'request', 1400, 0, { requestId: ids.user }),
        n('ok', 'if', 1680, 0, { condition: 'input.status === 200' }),
        n('name', 'evaluate', 1960, 0, { code: 'return input.body.name' }),
        n('user', 'output', 2240, 0, { label: 'User' }),
        n('count', 'evaluate', 1120, 260, { code: 'return input.length' }),
        n('total', 'output', 1400, 260, { label: 'Total' }),
        n('boom', 'evaluate', 1680, 260, { code: 'throw new Error("handled")' }),
        n('caught', 'output', 1960, 260, { label: 'Caught' }),
      ]
      const edges = [
        ['start', 'out', 'list'], ['list', 'response', 'tok'], ['tok', 'out', 'each'], ['each', 'item', 'shape'], ['shape', 'out', 'get'],
        ['get', 'response', 'ok'], ['ok', 'true', 'name'], ['name', 'out', 'user'], ['each', 'done', 'count'], ['count', 'out', 'total'],
        ['total', 'out', 'boom'], ['count', 'out', 'boom'], ['boom', 'error', 'caught'],
      ].map(([source, sourcePort, target], i) => ({ id: `e${i}`, source, sourcePort, target }))
      return (await s.createWorkflow({ workspaceId: ws.id, name: 'Walk users', graphJson: JSON.stringify({ v: 1, nodes, edges }) })).id
    }, ids)
    await reloadApp(page)
    await page.getByRole('tab', { name: 'Workflows' }).click()
    await page.getByRole('button', { name: 'Walk users', exact: true }).click()
    await node('start').waitFor()
    await page.keyboard.press('ControlOrMeta+Enter')
    await status().filter({ hasText: /Done|Failed/ }).waitFor({ timeout: 30_000 })
    expect(await status().innerText()).toMatch(/^Done in \d+ steps$/)
    const log = await page.getByTestId('wf-run-log').innerText()
    expect(log).toContain('User: "User 1"')
    expect(log).toContain('User: "User 2"')
    expect(log).toContain('Total: 2')
    expect(log).toContain('Caught: {"message":')
    expect(hits.slice(-3)).toEqual(['/users -', '/users/1 Bearer tok-9', '/users/2 Bearer tok-9'])
    await expect(node('get').locator('[data-status]').getAttribute('data-status')).resolves.toBe('done')
    expect(workflowId).toBeTruthy()
  })

  it('reopens its tab after a reload, and deleting closes it', async () => {
    const { page } = ctx
    await reloadApp(page)
    await expect(page.locator('[aria-controls=request-panel]').filter({ hasText: 'Walk users' }).count()).resolves.toBe(1)
    await page.getByRole('tab', { name: 'Workflows' }).click()
    await page.getByRole('button', { name: 'Walk users', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Delete/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect.poll(() => page.locator('[aria-controls=request-panel]').filter({ hasText: 'Walk users' }).count()).toBe(0)
    await expect(page.getByRole('button', { name: 'Walk users', exact: true }).count()).resolves.toBe(0)
  })

  it('logged no page errors', () => {
    expect(ctx.problems).toEqual([])
  })
})
