import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpCallResult } from '../../../shared/mcp'
import { app } from '../../app/state.svelte'
import { readExamples } from '../../lib/examples'
import { tabsStore } from '../requests/tabs.svelte'
import { runsStore } from '../runner/runs.svelte'
import { setupSync, teardownSync, type Backend } from '../sync/testUtils'
import HistoryPanel from '../history/HistoryPanel.svelte'
import McpHost from './McpHost.svelte'
import McpSettings from './McpSettings.svelte'
import { mcp } from './mcpStore.svelte'
import { mcpSnippet } from './snippets'
import { runTool } from './tools'

let b: Backend
beforeEach(async () => {
  b = await setupSync()
  // the store is a singleton: start every test from scratch
  mcp.status = null
  mcp.clients = null
  mcp.clientError = null
  mcp.active = 0
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
const readStored = (requestId: string) => readExamples(app.requestById(requestId)!.documentJson)
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

describe('saved examples', () => {
  it('lists, reads, adds, edits and deletes examples; an open example tab follows; stored fields not edited stay', async () => {
    const pets = app.requests.find((r) => r.name === 'List pets')!
    const { saved_examples } = await call('get_request', { request_id: pets.id })
    expect(saved_examples).toEqual([
      { index: 0, name: 'Two pets', status: 200 },
      { index: 1, name: 'Server error', status: 500 },
    ])
    const two = await call('get_example', { request_id: pets.id, example: 'Two pets' })
    expect(two).toMatchObject({ index: 0, name: 'Two pets', status_code: 200, request: { method: 'GET' } })
    expect(two.body.length).toBeGreaterThan(0)

    const { created } = await call('create_example', {
      request_id: pets.id,
      name: 'Empty list',
      body: '[]',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      request: { url: '{{baseUrl}}/pets?limit=0' },
    })
    expect(created).toMatchObject({ index: 2, name: 'Empty list', status_code: 200, status_text: 'OK', language: 'json', body: '[]', request: { url: '{{baseUrl}}/pets?limit=0' } })
    expect(readStored(pets.id)).toHaveLength(3) // the window's store has it

    const tab = tabsStore.openExample(app.requestById(pets.id)!, 2)
    const before = JSON.stringify(readStored(pets.id)[1])
    const { updated } = await call('update_example', { request_id: pets.id, example: 2, status_code: 404, body: '{"error":"none"}' })
    expect(updated).toMatchObject({ status_code: 404, status_text: 'Not Found', body: '{"error":"none"}', name: 'Empty list', request: { url: '{{baseUrl}}/pets?limit=0' } })
    expect(JSON.stringify(readStored(pets.id)[1])).toBe(before) // other examples untouched
    await waitFor(() => expect(tab.exampleDraft?.code).toBe(404))

    expect(await failure('get_example', { request_id: pets.id, example: 7 })).toContain('There is no example 7')
    expect(await failure('get_example', { request_id: pets.id, example: 'Nope' })).toContain('No saved example named')
    await call('create_example', { request_id: pets.id, name: 'Two pets' })
    expect(await failure('update_example', { request_id: pets.id, example: 'Two pets', status_code: 201 })).toContain('Several examples are named')

    const { deleted, saved_examples: left } = await call('delete_example', { request_id: pets.id, example: 'Empty list' })
    expect(deleted).toMatchObject({ index: 2, name: 'Empty list' })
    expect(left.map((e: any) => e.name)).toEqual(['Two pets', 'Server error', 'Two pets'])
  })

  it('send_request can keep the response as an example (needs a saved request)', async () => {
    const req = app.requests.find((r) => r.name === 'JSON sample')!
    const res = await call('send_request', { request_id: req.id, save_as_example: 'Live sample' })
    expect(res.saved_example).toMatchObject({ index: 0, name: 'Live sample' })
    const ex = await call('get_example', { request_id: req.id, example: 'Live sample' })
    expect(ex).toMatchObject({ status_code: res.response.status })
    expect(await failure('send_request', { url: 'https://mock.slinger.local/json', save_as_example: 'x' })).toContain('needs request_id')
  })
})

describe('collection versions', () => {
  it('saves versions (by bump or number), reads one with what changed since, and restores as a copy or in place', async () => {
    const { created: col } = await call('create_collection', { name: 'Shop' })
    const demo = app.collections.find((c) => c.id === col.id)!
    const { created: folder } = await call('create_folder', { collection_id: demo.id, name: 'Orders' })
    await call('create_request', { collection_id: demo.id, folder_id: folder.id, name: 'JSON sample', method: 'GET', url: 'https://mock.slinger.local/json' })
    await call('create_request', { collection_id: demo.id, name: 'Health', method: 'GET', url: 'https://mock.slinger.local/text' })
    const empty = await call('list_versions', { collection_id: demo.id })
    expect(empty.next).toEqual({ patch: '0.0.1', minor: '0.1.0', major: '1.0.0' })
    const first = (await call('create_version', { collection_id: demo.id, version: '1.0.0', notes: 'First cut' })).created
    expect(first).toMatchObject({ version: '1.0.0', notes: 'First cut' })
    expect(first.requests).toBeGreaterThan(0)
    expect((await call('create_version', { collection_id: demo.id, bump: 'minor' })).created.version).toBe('1.1.0')
    expect((await call('create_version', { collection_id: demo.id })).created.version).toBe('1.1.1') // default: patch
    expect(await failure('create_version', { collection_id: demo.id, version: '1.0.0' })).toContain('already exists')
    expect(await failure('create_version', { collection_id: demo.id, version: 'v2' })).toContain('prefix')
    expect(await failure('create_version', { collection_id: demo.id, version: '2.0.0', bump: 'major' })).toContain('not both')
    const listed = await call('list_versions', { collection_id: demo.id })
    expect(listed.versions.map((v: any) => v.version)).toEqual(['1.1.1', '1.1.0', '1.0.0'])
    expect(listed.next).toMatchObject({ patch: '1.1.2', minor: '1.2.0', major: '2.0.0' })

    // change the live collection, then compare
    const json = app.requests.find((r) => r.collectionId === demo.id && r.name === 'JSON sample')!
    await call('update_request', { request_id: json.id, method: 'PUT' })
    const { created: added } = await call('create_request', { collection_id: demo.id, name: 'Brand new', method: 'GET', url: 'https://x.test' })
    const v1 = await call('get_version', { collection_id: demo.id, version: 'v1.0.0' })
    expect(v1).toMatchObject({ version: '1.0.0', collection_name_then: 'Shop', folders: ['Orders'] })
    expect(v1.requests).toEqual(expect.arrayContaining([{ name: 'JSON sample', method: 'GET', url: 'https://mock.slinger.local/json', folder: 'Orders' }]))
    expect(v1.requests.some((r: any) => r.name === 'JSON sample' && r.method === 'GET')).toBe(true)
    expect(v1.changes_since.summary).toMatchObject({ added: 1, changed: 1 })
    expect(v1.changes_since.requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'Brand new', status: 'added' }), expect.objectContaining({ status: 'changed', changed: expect.arrayContaining(['method']) })]),
    )
    expect(await failure('get_version', { collection_id: demo.id, version: '9.9.9' })).toContain('has no version 9.9.9')

    // copy: a new collection, the live one untouched
    const copy = (await call('restore_version', { collection_id: demo.id, version: '1.0.0', mode: 'copy' })).restored
    expect(copy).toMatchObject({ mode: 'copy', collection: 'Shop (v1.0.0)' })
    expect(app.collections.some((c) => c.id === copy.collection_id)).toBe(true)
    expect(app.requestById(added.id)).toBeDefined()

    // replace: back to 1.0.0; an open tab follows the restored request
    tabsStore.openRequest(app.requestById(json.id)!)
    await call('restore_version', { collection_id: demo.id, version: '1.0.0', mode: 'replace' })
    const restored = app.requestsOf(demo.id)
    expect(restored.some((r) => r.name === 'Brand new')).toBe(false)
    const back = restored.find((r) => r.name === 'JSON sample')!
    expect(back.method).toBe('GET')
    await waitFor(() => expect(tabsStore.tabs.some((t) => t.requestId === back.id)).toBe(true))

    const { history } = await call('list_history', { limit: 3 })
    expect(history.map((h: any) => h.detail)).toEqual(['Replaced “Shop” with version 1.0.0', 'Restored version 1.0.0 of “Shop” as “Shop (v1.0.0)”', expect.stringContaining('Created request')])
  })
})

describe('history', () => {
  it('records what an assistant changed and sent, flagged; the History panel shows it', async () => {
    const demo = app.collections.find((c) => c.name === 'Demo API')!
    const { created } = await call('create_request', { collection_id: demo.id, name: 'Create order', method: 'POST', url: 'https://mock.slinger.local/json' })
    await call('update_request', { request_id: created.id, url: 'https://mock.slinger.local/json?v=2', headers: [] })
    await call('send_request', { request_id: created.id })
    const { created: env } = await call('create_environment', { name: 'Assistant env' })
    await call('set_variable', { environment_id: env.id, key: 'apiToken', value: 'sk_never_logged', secret: true })
    const { history } = await call('list_history', { limit: 10 })
    expect(history.slice(0, 5).map((h: any) => [h.kind ?? 'send', h.by, h.detail ?? `${h.method} ${h.status}`])).toEqual([
      ['edit', 'AI assistant', 'Added secret variable “apiToken” in “Assistant env”'],
      ['edit', 'AI assistant', 'Created environment “Assistant env”'],
      ['send', 'AI assistant', 'POST 200'],
      ['edit', 'AI assistant', 'Edited request “Create order”: url and headers'],
      ['edit', 'AI assistant', 'Created request “Create order” in “Demo API”'],
    ])
    expect(JSON.stringify(history)).not.toContain('sk_never_logged')

    render(HistoryPanel)
    const edits = await screen.findAllByTestId('history-edit')
    expect(edits[0]).toHaveTextContent('Added secret variable “apiToken” in “Assistant env”')
    expect(screen.getAllByText('AI assistant').length).toBeGreaterThanOrEqual(5)
    // clicking an edit of a request opens that request
    await userEvent.setup().click(screen.getByText('Edited request “Create order”: url and headers'))
    expect(tabsStore.tabs.some((t) => t.requestId === created.id)).toBe(true)
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

  it('Settings: one Connect per assistant found; connecting turns the server on and says what to do next', async () => {
    const ev = userEvent.setup()
    render(McpSettings, { props: { now: Math.floor(Date.now() / 1000) } })
    const desktop = await screen.findByTestId('mcp-client-claude-desktop')
    expect(screen.getByTestId('mcp-status')).toHaveTextContent('Off. Connecting an assistant turns it on.')
    expect(screen.getByTestId('mcp-client-cursor')).toHaveTextContent('Connected')
    expect(screen.queryByTestId('mcp-client-vscode')).toBeNull()
    expect(screen.getByText('Not found on this computer: VS Code, Windsurf.')).toBeInTheDocument()

    await ev.click(within(desktop).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(within(desktop).getByText('Connected')).toBeInTheDocument())
    expect(await within(desktop).findByText('Quit Claude Desktop completely and open it again.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('mcp-status')).toHaveTextContent('On.'))

    await ev.click(within(desktop).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(within(desktop).getByRole('button', { name: 'Connect' })).toBeInTheDocument())
  })

  it('Settings: a failed Connect explains itself on that row', async () => {
    b.mcp.failNextConnect('claude_desktop_config.json is not plain JSON (it may contain comments), so Slinger leaves it alone.')
    render(McpSettings, { props: { now: 0 } })
    const desktop = await screen.findByTestId('mcp-client-claude-desktop')
    await userEvent.setup().click(within(desktop).getByRole('button', { name: 'Connect' }))
    expect(await within(desktop).findByRole('alert')).toHaveTextContent('not plain JSON')
  })

  it('Settings: other assistants get a token-free command, or a URL setup that copies the real token; a new token can be made', async () => {
    const ev = userEvent.setup() // installs a working clipboard
    await b.setMcpSettings({ enabled: true, port: 7354 })
    render(McpSettings, { props: { now: 0 } })
    await ev.click(await screen.findByText('Other assistants and advanced'))
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('ELECTRON_RUN_AS_NODE')
    expect(screen.getByTestId('mcp-snippet')).not.toHaveTextContent('token')
    await ev.click(screen.getByRole('radio', { name: 'URL + token' }))
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('Bearer <token>')
    await ev.click(screen.getByRole('button', { name: 'Copy setup' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(mcpSnippet('http', mcp.status!, await b.revealMcpToken())))

    const before = await b.revealMcpToken()
    await ev.click(screen.getByRole('button', { name: 'New token' }))
    await ev.click(within(await screen.findByRole('dialog', { hidden: true })).getByRole('button', { name: 'Make a new token' }))
    await waitFor(async () => expect(await b.revealMcpToken()).not.toBe(before))
  })

  it('shows a server that cannot start', async () => {
    b.mcp.failNextStart()
    render(McpSettings, { props: { now: 0 } })
    await userEvent.setup().click(await screen.findByRole('checkbox', { name: /Let AI assistants/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Port 7354 is already in use')
  })
})

describe('snippets', () => {
  const status = { url: 'http://127.0.0.1:7354/mcp', stdio: { command: '/opt/Slinger/slinger', args: ['/home/u/.config/Slinger/mcp/bridge.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } }
  it('builds a token-free command setup and a URL + token setup', () => {
    expect(JSON.parse(mcpSnippet('command', status, 'slg_t'))).toEqual({ mcpServers: { slinger: status.stdio } })
    expect(JSON.parse(mcpSnippet('http', status, 'slg_t'))).toEqual({ mcpServers: { slinger: { type: 'http', url: status.url, headers: { Authorization: 'Bearer slg_t' } } } })
  })
})
