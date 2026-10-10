import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES, type McpCall, type McpCallResult } from '../../shared/mcp'
import { openDatabase, type Db } from '../db/database'
import { runMigrations } from '../db/migrate'
import { McpBridge } from '../mcp/bridge'
import { MCP_TOKEN_KEY, McpService } from '../mcp/service'
import { relay, type BridgeState } from '../mcp/stdioBridge'
import { connectClient, disconnectClient, listClients, type ClientsEnv } from '../mcp/clients'
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
let userData: string

const makeService = () =>
  new McpService({
    db,
    secrets,
    appVersion: '9.9.9',
    userDataDir: userData,
    bridgeSource: join(userData, 'source-bridge.cjs'),
    executable: '/opt/Slinger/slinger',
    hostReadyTimeoutMs: 50,
    emit: (call) => {
      if (!hasWindow) return false
      calls.push(call)
      const r = answer?.(call)
      if (r) setTimeout(() => mcp.respond(call.id, r), 1)
      return true
    },
  })

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'slinger-mcp-'))
  writeFileSync(join(userData, 'source-bridge.cjs'), '// bridge v1\n')
  db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  secrets = new MemorySecretStore()
  calls = []
  answer = (c) => ({ ok: true, text: `ran ${c.tool}`, data: { tool: c.tool, args: c.args as Record<string, unknown> } })
  hasWindow = true
  mcp = makeService()
  await mcp.init()
  mcp.hostReady()
})
afterEach(async () => {
  await mcp.stop()
  db.close()
  rmSync(userData, { recursive: true, force: true })
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
    // Assistants get a command without token or port...
    expect(mcp.status().stdio).toEqual({ command: '/opt/Slinger/slinger', args: [join(userData, 'mcp', 'bridge.cjs')], env: { ELECTRON_RUN_AS_NODE: '1' } })
    // ...the bridge (copied next to its files) finds them in endpoint.json, readable by the user only.
    const dir = join(userData, 'mcp')
    expect(readFileSync(join(dir, 'bridge.cjs'), 'utf8')).toBe('// bridge v1\n')
    expect(JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'))).toEqual({ url, token })
    if (process.platform !== 'win32') expect(statSync(join(dir, 'endpoint.json')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8'))).toEqual({ enabled: true, command: '/opt/Slinger/slinger', args: [] })
    await mcp.update({ enabled: false, port: 0 })
    expect(mcp.status().running).toBe(false)
    expect(existsSync(join(dir, 'endpoint.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8')).enabled).toBe(false)
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

  it('waits for the window to be ready (it may be starting), then runs the call', async () => {
    const { url, token } = await enable()
    mcp.hostGone()
    const client = await connect(url, token)
    const pending = client.callTool({ name: 'list_workspaces', arguments: {} })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(0)
    mcp.hostReady()
    expect((await pending).isError).toBeFalsy()
    mcp.hostGone()
    const late = await client.callTool({ name: 'list_workspaces', arguments: {} }) // nobody gets ready within 50 ms
    expect(JSON.stringify(late.content)).toContain('still starting')
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

  it('moves to the next free port when the chosen one is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as { port: number }).port
    const s = await mcp.update({ enabled: true, port })
    expect(s).toMatchObject({ enabled: true, running: true, error: null, portNote: `Port ${port} was busy, so ${port + 1} is used.` })
    expect(s.url).toBe(`http://127.0.0.1:${port + 1}/mcp`)
    expect(JSON.parse(readFileSync(join(userData, 'mcp', 'endpoint.json'), 'utf8')).url).toBe(s.url)
    await new Promise<void>((r) => blocker.close(() => r()))
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
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } })
  const dir = () => join(userData, 'mcp')

  it('finds the endpoint by itself and relays JSON-RPC lines', async () => {
    await enable()
    const out: string[] = []
    const state: BridgeState = {}
    await relay(init, { dir: dir() }, (l) => out.push(l), state)
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: 'slinger' } } })
    expect(state.protocolVersion).toBe('2025-06-18')
    await relay(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), { dir: dir() }, (l) => out.push(l), state)
    expect(out).toHaveLength(1)
    // a new token is picked up without touching the assistant's configuration
    mcp.regenerateToken()
    await relay(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workspaces', arguments: {} } }), { dir: dir() }, (l) => out.push(l), state)
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: 'ran list_workspaces' }] } })
  })

  it('starts Slinger when it is not running, then forwards', async () => {
    await enable()
    const { url } = mcp.status()
    await mcp.stop() // "Slinger quit": endpoint.json stays, nothing listens
    const spawned: Array<{ command: string; args: string[] }> = []
    const out: string[] = []
    await relay(
      init,
      {
        dir: dir(),
        pollMs: 10,
        spawnImpl: (command, args, env) => {
          spawned.push({ command, args })
          expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
          void mcp.update({ enabled: true, port: Number(new URL(url).port) }) // "the app started"
        },
      },
      (l) => out.push(l),
      {},
    )
    expect(spawned).toEqual([{ command: '/opt/Slinger/slinger', args: [] }])
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: 'slinger' } } })
  })

  it('does not start Slinger when the server was turned off, and explains', async () => {
    await enable()
    await mcp.update({ enabled: false, port: 0 })
    const out: string[] = []
    let spawned = 0
    await relay(init, { dir: dir(), spawnImpl: () => void spawned++ }, (l) => out.push(l), {})
    expect(spawned).toBe(0)
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, error: { message: expect.stringContaining('turned off') } })
  })

  it('with a fixed endpoint (manual setup): wrong token and nothing listening are errors, junk is ignored', async () => {
    const { url } = await enable()
    const out: string[] = []
    await relay(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), { endpoint: { url, token: 'slg_wrong' } }, (l) => out.push(l), {})
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 7, error: { message: expect.stringContaining('HTTP 401') } })
    await mcp.update({ enabled: false, port: 0 })
    await relay(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }), { endpoint: { url, token: 'x' } }, (l) => out.push(l), {})
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 8, error: { message: expect.stringContaining('not running') } })
    await relay('not json', { endpoint: { url, token: 'x' } }, (l) => out.push(l), {})
    expect(out).toHaveLength(2)
  })
})

describe('connecting assistants', () => {
  let home: string
  let ran: string[][]
  let claudeCode: Record<string, unknown> | null
  const entry = { command: '/opt/Slinger/slinger', args: ['/home/u/.config/Slinger/mcp/bridge.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const env = (platform: NodeJS.Platform = 'linux', claude: string | null = '/usr/bin/claude'): ClientsEnv => ({
    home,
    platform,
    appData: join(home, 'AppData'),
    findExecutable: async () => claude,
    run: async (command, args) => {
      ran.push([command, ...args])
      // a tiny stand-in for the claude CLI: it keeps ~/.claude.json
      const file = join(home, '.claude.json')
      const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      cfg.mcpServers ??= {}
      if (args[1] === 'add-json') {
        expect(args.slice(2, 5)).toEqual(['--scope', 'user', 'slinger'])
        cfg.mcpServers.slinger = JSON.parse(args[5]!)
      } else if (args[1] === 'remove') {
        if (!cfg.mcpServers.slinger) return { code: 1, stdout: '', stderr: 'No MCP server found with name: slinger' }
        delete cfg.mcpServers.slinger
      }
      writeFileSync(file, JSON.stringify(cfg))
      claudeCode = cfg
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slinger-home-'))
    ran = []
    claudeCode = null
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists what is installed and connects Claude Desktop without touching its other servers (backup kept)', async () => {
    const claudeDir = join(home, '.config', 'Claude')
    mkdirSync(claudeDir, { recursive: true })
    const file = join(claudeDir, 'claude_desktop_config.json')
    const before = { mcpServers: { github: { command: 'gh-mcp' } }, theme: 'dark' }
    writeFileSync(file, JSON.stringify(before))
    let list = await listClients(env(), entry)
    expect(list.map((c) => [c.id, c.installed, c.state])).toEqual([
      ['claude-desktop', true, 'not-connected'],
      ['claude-code', true, 'not-connected'],
      ['cursor', false, 'not-connected'],
      ['vscode', false, 'not-connected'],
      ['windsurf', false, 'not-connected'],
    ])
    await connectClient(env(), 'claude-desktop', entry)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...before, mcpServers: { github: { command: 'gh-mcp' }, slinger: entry } })
    expect(JSON.parse(readFileSync(`${file}.slinger-backup`, 'utf8'))).toEqual(before)
    list = await listClients(env(), entry)
    expect(list.find((c) => c.id === 'claude-desktop')!.state).toBe('connected')
    // Slinger moved (another install): shown as outdated until connected again
    expect((await listClients(env(), { ...entry, command: '/elsewhere/slinger' })).find((c) => c.id === 'claude-desktop')!.state).toBe('outdated')
    await disconnectClient(env(), 'claude-desktop')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...before, mcpServers: { github: { command: 'gh-mcp' } } })
  })

  it('creates missing files, uses VS Code\'s format, and leaves files with comments alone', async () => {
    await connectClient(env(), 'cursor', entry)
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { slinger: entry } })
    await connectClient(env(), 'vscode', entry)
    expect(JSON.parse(readFileSync(join(home, '.config', 'Code', 'User', 'mcp.json'), 'utf8'))).toEqual({ servers: { slinger: { type: 'stdio', ...entry } } })
    const ws = join(home, '.codeium', 'windsurf')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'mcp_config.json'), '{ // mine\n "mcpServers": {} }')
    await expect(connectClient(env(), 'windsurf', entry)).rejects.toThrow('not plain JSON')
    expect(readFileSync(join(ws, 'mcp_config.json'), 'utf8')).toContain('// mine')
  })

  it('uses the platform folders on Windows and macOS', async () => {
    await connectClient(env('win32'), 'claude-desktop', entry)
    expect(existsSync(join(home, 'AppData', 'Claude', 'claude_desktop_config.json'))).toBe(true)
    await connectClient(env('darwin'), 'vscode', entry)
    expect(existsSync(join(home, 'AppData', 'Code', 'User', 'mcp.json'))).toBe(true)
  })

  it('connects Claude Code through its CLI (user scope), replacing an old entry', async () => {
    await connectClient(env(), 'claude-code', entry)
    expect(ran).toEqual([
      ['/usr/bin/claude', 'mcp', 'remove', '--scope', 'user', 'slinger'],
      ['/usr/bin/claude', 'mcp', 'add-json', '--scope', 'user', 'slinger', JSON.stringify({ type: 'stdio', ...entry })],
    ])
    expect((await listClients(env(), entry)).find((c) => c.id === 'claude-code')!.state).toBe('connected')
    await disconnectClient(env(), 'claude-code')
    expect(claudeCode).toEqual({ mcpServers: {} })
    await expect(connectClient(env('linux', null), 'claude-code', entry)).rejects.toThrow('was not found')
  })

  it('Connect turns the server on; the service lists and connects with its own command', async () => {
    const svc = new McpService({ db, secrets, appVersion: '1', userDataDir: userData, executable: '/opt/Slinger/slinger', emit: () => false, clientsEnv: env() })
    await svc.update({ enabled: false, port: 0 }) // any free port
    await svc.connect('cursor')
    expect(svc.settings().enabled).toBe(true)
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(cfg.mcpServers.slinger).toEqual(svc.stdioEntry())
    await expect(svc.connect('windsurf')).resolves.toBeDefined()
    await svc.stop()
  })
})
