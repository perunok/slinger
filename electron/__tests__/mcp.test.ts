import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES, type McpCall, type McpCallResult } from '../../shared/mcp'
import { openDatabase, type Db } from '../db/database'
import { runMigrations } from '../db/migrate'
import { McpBridge } from '../mcp/bridge'
import { MCP_TOKEN_KEY, McpService } from '../mcp/service'
import { relay } from '../mcp/stdioBridge'
import { MemorySecretStore } from '../services/secrets'
import { getSetting } from '../sync/store'
import { MIGRATIONS_DIR } from './helpers'

let db: Db
let secrets: MemorySecretStore
let calls: McpCall[]
/** What the fake renderer answers; null = never answers. */
let answer: ((call: McpCall) => McpCallResult | null) | null
let hasWindow: boolean
let mcp: McpService

beforeEach(() => {
  db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  secrets = new MemorySecretStore()
  calls = []
  answer = (c) => ({ ok: true, text: `ran ${c.tool}`, data: { tool: c.tool, args: c.args as Record<string, unknown> } })
  hasWindow = true
  mcp = new McpService({
    db,
    secrets,
    appVersion: '9.9.9',
    stdioCommand: { command: '/opt/Slinger/slinger', args: ['/opt/Slinger/resources/app.asar.unpacked/dist-electron/mcp-stdio.cjs'] },
    emit: (call) => {
      if (!hasWindow) return false
      calls.push(call)
      const r = answer?.(call)
      if (r) setTimeout(() => mcp.respond(call.id, r), 1)
      return true
    },
  })
})
afterEach(async () => {
  await mcp.stop()
  db.close()
})

async function enable(): Promise<{ url: string; token: string }> {
  const s = await mcp.update({ enabled: true, port: 0 })
  expect(s.running).toBe(true)
  return { url: s.url, token: mcp.revealToken() }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

/** fetch() refuses to set Host, so a forged one goes through node:http. Resolves with the status code. */
const postWithHost = (url: string, host: string, token: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
      (res) => (res.resume(), resolve(res.statusCode!)),
    )
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  })

const post = (url: string, headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })

describe('MCP endpoint', () => {
  it('is off by default; enabling starts it on 127.0.0.1 with a token kept in the keychain, not the database', async () => {
    expect(mcp.status()).toMatchObject({ enabled: false, running: false, port: 7354, url: 'http://127.0.0.1:7354/mcp', calls: 0 })
    const { url, token } = await enable()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(token).toMatch(/^slg_[\w-]{43}$/)
    expect(secrets.get(MCP_TOKEN_KEY)).toBe(token)
    expect(getSetting(db, 'mcp')).not.toContain(token)
    expect(mcp.status().stdio).toEqual({
      command: '/opt/Slinger/slinger',
      args: ['/opt/Slinger/resources/app.asar.unpacked/dist-electron/mcp-stdio.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', SLINGER_MCP_URL: url, SLINGER_MCP_TOKEN: '<token>' },
    })
    await mcp.update({ enabled: false, port: 0 })
    expect(mcp.status().running).toBe(false)
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
  })

  it('lists every tool with a JSON schema and safety hints', async () => {
    const { url, token } = await enable()
    const client = await connect(url, token)
    expect(client.getServerVersion()).toMatchObject({ name: 'slinger', version: '9.9.9' })
    expect(client.getInstructions()).toContain('list_workspaces')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOL_NAMES)
    const send = tools.find((t) => t.name === 'send_request')!
    expect(send.annotations).toMatchObject({ openWorldHint: true, readOnlyHint: false })
    expect(send.inputSchema.properties).toHaveProperty('request_id')
    expect(tools.find((t) => t.name === 'delete')!.annotations).toMatchObject({ destructiveHint: true })
    expect(tools.find((t) => t.name === 'get_tree')!.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === 'create_request')!.inputSchema.required).toEqual(['collection_id', 'name', 'method', 'url'])
    await client.close()
  })

  it('forwards a validated call to the window and returns its text and structured result', async () => {
    const { url, token } = await enable()
    const client = await connect(url, token)
    const res = await client.callTool({ name: 'get_request', arguments: { request_id: 'r1' } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'ran get_request' }])
    expect(res.structuredContent).toEqual({ tool: 'get_request', args: { request_id: 'r1' } })
    expect(calls).toHaveLength(1)
    expect(mcp.status()).toMatchObject({ calls: 1 })
    expect(mcp.status().lastCallAt).toBeGreaterThan(0)

    // invalid arguments and unknown tools never reach the window
    const bad = await client.callTool({ name: 'create_request', arguments: { collection_id: 'c', name: 'x' } })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toContain('Invalid arguments')
    const unknown = await client.callTool({ name: 'format_disk', arguments: {} })
    expect(unknown.isError).toBe(true)
    expect(calls).toHaveLength(1)

    // a tool failure comes back as an error result
    answer = () => ({ ok: false, error: 'Request not found.' })
    const failed = await client.callTool({ name: 'get_request', arguments: { request_id: 'nope' } })
    expect(failed).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Request not found.' }] })
    await client.close()
  })

  it('says so when the window is not open', async () => {
    const { url, token } = await enable()
    hasWindow = false
    const client = await connect(url, token)
    const res = await client.callTool({ name: 'list_workspaces', arguments: {} })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('window is not open')
    await client.close()
  })

  it('refuses a missing or wrong token, browser origins, foreign hosts, other paths and GET', async () => {
    const { url, token } = await enable()
    const port = new URL(url).port
    expect((await post(url, {})).status).toBe(401)
    expect((await post(url, { authorization: 'Bearer slg_wrong' })).status).toBe(401)
    expect((await post(url, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403)
    expect(await postWithHost(url, `evil.example:${port}`, token)).toBe(403)
    expect(await postWithHost(url, `127.0.0.1:${Number(port) + 1}`, token)).toBe(403)
    expect((await post(url.replace('/mcp', '/other'), { authorization: `Bearer ${token}` })).status).toBe(404)
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405)
    expect(await postWithHost(url, `localhost:${port}`, token)).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('a new token locks out the old one', async () => {
    const { url, token } = await enable()
    mcp.regenerateToken()
    const fresh = mcp.revealToken()
    expect(fresh).not.toBe(token)
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(401)
    expect((await post(url, { authorization: `Bearer ${fresh}` })).status).toBe(200)
  })

  it('reports a port that is in use instead of failing', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as { port: number }).port
    const s = await mcp.update({ enabled: true, port })
    expect(s).toMatchObject({ enabled: true, running: false, error: `Port ${port} is already in use. Choose another port.` })
    await new Promise<void>((r) => blocker.close(() => r()))
    expect((await mcp.update({ enabled: true, port })).running).toBe(true)
  })
})

describe('bridge', () => {
  it('times out a call the window never answers, and ignores late answers', async () => {
    const sent: McpCall[] = []
    const bridge = new McpBridge((c) => (sent.push(c), true))
    const r = await bridge.call('list_workspaces', {}, 20)
    expect(r).toEqual({ ok: false, error: 'Slinger did not finish "list_workspaces" within 0 s.' })
    bridge.respond(sent[0]!.id, { ok: true, text: 'late' })
    const p = bridge.call('get_tree', {}, 10_000)
    bridge.failAll('Slinger is shutting down.')
    expect(await p).toEqual({ ok: false, error: 'Slinger is shutting down.' })
  })
})

describe('stdio bridge', () => {
  it('relays JSON-RPC lines to the endpoint and writes the answers as lines', async () => {
    const { url, token } = await enable()
    const out: string[] = []
    const state: { protocolVersion?: string } = {}
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } }
    await relay(JSON.stringify(init), { url, token }, (l) => out.push(l), state)
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: 'slinger' } } })
    expect(state.protocolVersion).toBe('2025-06-18')
    await relay(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), { url, token }, (l) => out.push(l), state)
    expect(out).toHaveLength(1)
    await relay(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workspaces', arguments: {} } }), { url, token }, (l) => out.push(l), state)
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: 'ran list_workspaces' }] } })
  })

  it('answers requests with an error when the token is wrong or Slinger is not running', async () => {
    const { url } = await enable()
    const out: string[] = []
    await relay(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), { url, token: 'slg_wrong' }, (l) => out.push(l), {})
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 7, error: { message: expect.stringContaining('HTTP 401') } })
    await mcp.update({ enabled: false, port: 0 })
    await relay(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }), { url, token: 'x' }, (l) => out.push(l), {})
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 8, error: { message: expect.stringContaining('not running') } })
    await relay('not json', { url, token: 'x' }, (l) => out.push(l), {})
    expect(out).toHaveLength(2)
  })
})
