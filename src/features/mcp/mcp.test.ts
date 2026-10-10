import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpCallResult } from '../../../shared/mcp'
import { app } from '../../app/state.svelte'
import { tabsStore } from '../requests/tabs.svelte'
import { runsStore } from '../runner/runs.svelte'
import { setupSync, teardownSync, type Backend } from '../sync/testUtils'
import McpHost from './McpHost.svelte'
import McpSettings from './McpSettings.svelte'
import { mcp } from './mcpStore.svelte'
import { mcpSnippet } from './snippets'
import { runTool } from './tools'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
})
afterEach(() => {
  cleanup()
  teardownSync()
  runsStore.sessions = []
})

/** Runs a tool and returns its JSON result (fails the test when the tool failed). */
async function call<T = any>(tool: string, args: unknown = {}): Promise<T> {
  const r = await runTool(tool, args)
  if (!r.ok) throw new Error(`${tool} failed: ${r.error}`)
  expect(JSON.parse(r.text)).toEqual(r.data)
  return r.data as T
}
const failure = async (tool: string, args: unknown = {}) => {
  const r = (await runTool(tool, args)) as Extract<McpCallResult, { ok: false }>
  expect(r.ok).toBe(false)
  return r.error
}

describe('reading', () => {
  it('lists workspaces and the tree of the open one', async () => {
    const ws = await call('list_workspaces')
    expect(ws.workspaces.find((w: any) => w.open).id).toBe(app.workspaceId)
    const tree = await call('get_tree')
    const demo = tree.collections.find((c: any) => c.name === 'Demo API')
    expect(demo.requests.some((r: any) => r.name === 'JSON sample' && r.method === 'GET')).toBe(true)
    expect(demo.folders.map((f: any) => f.name)).toContain('Users')
    const only = await call('get_tree', { collection_id: demo.id })
    expect(only.collections).toHaveLength(1)
    expect(await failure('get_tree', { collection_id: 'nope' })).toContain('No collection')
  })

  it('searches by name, URL or method, also in another workspace', async () => {
    const hits = await call('search_requests', { query: 'json sample' })
    expect(hits.matches[0]).toMatchObject({ name: 'JSON sample', collection: 'Demo API' })
    const other = app.workspaces.find((w) => w.id !== app.workspaceId)!
    expect((await call('search_requests', { query: 'ping', workspace_id: other.id })).matches.length).toBeGreaterThan(0)
  })
})

describe('editing requests', () => {
  it('creates a request with headers, query, JSON body, auth and scripts; the window shows it; literal secrets are masked', async () => {
    const demo = app.collections.find((c) => c.name === 'Demo API')!
    const { created } = await call('create_request', {
      collection_id: demo.id,
      name: 'Create order',
      method: 'post',
      url: '{{baseUrl}}/orders',
      query: [{ key: 'dry_run', value: 'true' }],
      headers: [{ key: 'X-Trace', value: 'abc' }],
      body: { mode: 'json', raw: '{"qty": 2}' },
      auth: { type: 'bearer', token: 'sk_live_literal' },
      test_script: 'pm.test("ok", () => pm.response.to.have.status(201))',
    })
    expect(created).toMatchObject({
      name: 'Create order',
      method: 'POST',
      url: '{{baseUrl}}/orders?dry_run=true',
      query: [{ key: 'dry_run', value: 'true', enabled: true }],
      headers: [{ key: 'X-Trace', value: 'abc', enabled: true }],
      body: { mode: 'json', raw: '{"qty": 2}' },
      auth: { type: 'bearer', token: '•••• (set, hidden)' },
      test_script: 'pm.test("ok", () => pm.response.to.have.status(201))',
      pre_request_script: '',
    })
    expect(app.requests.some((r) => r.id === created.id)).toBe(true) // the sidebar has it
    expect(JSON.stringify(await call('get_request', { request_id: created.id }))).not.toContain('sk_live_literal')

    // only the given parts change; a variable reference stays visible
    const { updated } = await call('update_request', { request_id: created.id, url: '{{baseUrl}}/v2/orders', auth: { type: 'bearer', token: '{{apiToken}}' } })
    expect(updated).toMatchObject({ url: '{{baseUrl}}/v2/orders', headers: [{ key: 'X-Trace', value: 'abc', enabled: true }], auth: { type: 'bearer', token: '{{apiToken}}' } })
    expect(app.requestById(created.id)?.url).toBe('{{baseUrl}}/v2/orders')
    const scripts = await call('update_request', { request_id: created.id, test_script: '' })
    expect(scripts.updated.test_script).toBe('')
  })

  it('an open, clean tab follows edits; moving, renaming and deleting work and show in the window', async () => {
    const demo = app.collections.find((c) => c.name === 'Demo API')!
    const req = app.requests.find((r) => r.name === 'JSON sample')!
    const tab = tabsStore.openRequest(req)
    await call('update_request', { request_id: req.id, method: 'PUT' })
    await waitFor(() => expect(tab.draft.method).toBe('PUT'))
    expect(tab.dirty).toBe(false)

    const { created: folder } = await call('create_folder', { collection_id: demo.id, name: 'Orders' })
    await call('move_request', { request_id: req.id, collection_id: demo.id, folder_id: folder.id })
    expect(app.requestById(req.id)?.folderId).toBe(folder.id)
    await call('rename', { kind: 'request', id: req.id, name: 'JSON (renamed)' })
    expect(app.requestById(req.id)?.name).toBe('JSON (renamed)')
    await call('delete', { kind: 'request', id: req.id })
    expect(app.requestById(req.id)).toBeUndefined()
    expect(await failure('get_request', { request_id: req.id })).toContain('No request')
  })

  it('creates collections, imports Postman files, and rejects bad arguments without touching anything', async () => {
    const { created } = await call('create_collection', { name: 'From the assistant' })
    expect(app.collections.some((c) => c.id === created.id)).toBe(true)
    const file = JSON.stringify({ info: { name: 'Imported by AI', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'Ping', request: { method: 'GET', url: 'https://example.test/ping' } }] })
    const { imported } = await call('import_postman', { collection_json: file })
    expect(imported).toMatchObject({ name: 'Imported by AI', requests: 1 })
    expect(await failure('create_request', { collection_id: created.id, name: 'x' })).toContain('Invalid arguments')
    expect(await failure('format_disk')).toContain('Unknown tool')
  })
})

describe('environments', () => {
  it('sets plain and secret variables; secret values never come back', async () => {
    const { created: env } = await call('create_environment', { name: 'QA (assistant)' })
    await call('set_variable', { environment_id: env.id, key: 'baseUrl', value: 'https://staging.example.test' })
    await call('set_variable', { environment_id: env.id, key: 'apiToken', value: 'sk_super_secret', secret: true })
    const { environments } = await call('list_environments')
    const qa = environments.find((e: any) => e.id === env.id)
    expect(qa.variables).toHaveLength(2)
    expect(qa.variables).toEqual(
      expect.arrayContaining([
        { key: 'baseUrl', value: 'https://staging.example.test' },
        { key: 'apiToken', secret: true, value_set: true },
      ]),
    )
    expect(JSON.stringify(environments)).not.toContain('sk_super_secret')
    // changing the value keeps it secret unless told otherwise
    expect((await call('set_variable', { environment_id: env.id, key: 'apiToken', value: 'sk_rotated' })).set).toMatchObject({ secret: true, created: false })
    await call('delete_variable', { environment_id: env.id, key: 'baseUrl' })
    await call('set_active_environment', { environment_id: env.id })
    expect(app.activeEnvironmentId).toBe(env.id)
    expect((await call('list_environments')).environments.find((e: any) => e.id === env.id)).toMatchObject({ active: true, variables: [{ key: 'apiToken' }] })
  })
})

describe('sending', () => {
  it('sends a saved request like the Send button and returns status, headers and body; history records it', async () => {
    const req = app.requests.find((r) => r.name === 'JSON sample')!
    const tick = app.historyTick
    const { response } = await call('send_request', { request_id: req.id })
    expect(response.status).toBe(200)
    expect(response.headers.length).toBeGreaterThan(0)
    expect(typeof response.body).toBe('string')
    expect(app.historyTick).toBe(tick + 1)
    const { history } = await call('list_history', { limit: 5 })
    expect(history[0]).toMatchObject({ method: 'GET', request_id: req.id })
  })

  it('sends ad-hoc requests, reports unresolved variables, and only sends in the open workspace', async () => {
    const adHoc = await call('send_request', { method: 'GET', url: 'https://mock.slinger.local/json' })
    expect(adHoc.response.status).toBe(200)
    expect(await failure('send_request', { url: 'https://mock.slinger.local/{{nowhere}}' })).toContain('nowhere')
    expect(await failure('send_request', {})).toContain('request_id')
    const other = app.workspaces.find((w) => w.id !== app.workspaceId)!
    const otherReq = (await call('search_requests', { query: 'ping', workspace_id: other.id })).matches[0]
    expect(await failure('send_request', { request_id: otherReq.id })).toContain('open_in_app')
    await call('open_in_app', { request_id: otherReq.id })
    expect(app.workspaceId).toBe(other.id)
    expect(tabsStore.tabs.some((t) => t.requestId === otherReq.id)).toBe(true)
  })

  it('runs a collection and reports every request', async () => {
    const demo = app.collections.find((c) => c.name === 'Demo API')!
    const users = app.foldersOf(demo.id).find((f) => f.name === 'Users')!
    const { run, summary, results } = await call('run_collection', { collection_id: demo.id, folder_id: users.id })
    expect(run).toBe('Users')
    expect(summary.total).toBe(results.length)
    expect(results[0]).toMatchObject({ iteration: 1, result: expect.stringMatching(/passed|failed/) })
  })
})

describe('host and settings', () => {
  it('McpHost answers calls from main (here: the mock playing the client)', async () => {
    render(McpHost)
    await b.setMcpSettings({ enabled: true, port: 7354 })
    const r = await b.mcp.call('list_workspaces')
    expect(r.ok).toBe(true)
    await waitFor(() => expect(mcp.active).toBe(0))
    expect(mcp.lastTool).toBe('List workspaces')
  })

  it('Settings turns it on, shows where it runs, copies setups with the real token, and replaces the token', async () => {
    const ev = userEvent.setup() // installs a working clipboard
    render(McpSettings, { props: { now: Math.floor(Date.now() / 1000) } })
    await ev.click(await screen.findByRole('checkbox', { name: /Let AI assistants work in Slinger/ }))
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('Running at http://127.0.0.1:7354/mcp'))
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('Authorization: Bearer <token>')
    await ev.click(screen.getByRole('button', { name: 'Copy setup' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(mcpSnippet('claude-code', mcp.status!, await b.revealMcpToken())))
    await ev.click(screen.getByRole('radio', { name: 'Claude Desktop' }))
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('ELECTRON_RUN_AS_NODE')

    const before = await b.revealMcpToken()
    await ev.click(screen.getByRole('button', { name: 'New token' }))
    await ev.click(within(await screen.findByRole('dialog', { hidden: true })).getByRole('button', { name: 'Make a new token' }))
    await waitFor(async () => expect(await b.revealMcpToken()).not.toBe(before))
  })

  it('shows a port in use', async () => {
    b.mcp.failNextStart()
    render(McpSettings, { props: { now: 0 } })
    await userEvent.setup().click(await screen.findByRole('checkbox', { name: /Let AI assistants/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Port 7354 is already in use')
  })
})

describe('snippets', () => {
  const status = { url: 'http://127.0.0.1:7354/mcp', stdio: { command: '/opt/Slinger/slinger', args: ['/x/mcp-stdio.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', SLINGER_MCP_URL: 'http://127.0.0.1:7354/mcp', SLINGER_MCP_TOKEN: '<token>' } } }
  it('builds a Claude Code command, an HTTP config and a Claude Desktop stdio config', () => {
    expect(mcpSnippet('claude-code', status, 'slg_t')).toBe("claude mcp add --scope user --transport http slinger http://127.0.0.1:7354/mcp --header 'Authorization: Bearer slg_t'")
    expect(JSON.parse(mcpSnippet('json-http', status, 'slg_t'))).toEqual({ mcpServers: { slinger: { type: 'http', url: status.url, headers: { Authorization: 'Bearer slg_t' } } } })
    expect(JSON.parse(mcpSnippet('claude-desktop', status, 'slg_t')).mcpServers.slinger).toEqual({
      command: '/opt/Slinger/slinger',
      args: ['/x/mcp-stdio.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', SLINGER_MCP_URL: status.url, SLINGER_MCP_TOKEN: 'slg_t' },
    })
  })
})
