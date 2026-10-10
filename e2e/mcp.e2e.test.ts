/**
 * The MCP server end to end: an MCP client (the official SDK) talks HTTP to the real app, main forwards each tool call
 * to the renderer, and the result comes back. Also the stdio bridge, started the way Claude Desktop starts it (the
 * Electron binary in Node mode). Steps run in order and share one app.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { McpStatus } from '../shared/mcp'
import { launch, type Launched } from './support/app'
import { startTarget } from './support/server'

let tmp: string
let ctx: Launched
let target: Awaited<ReturnType<typeof startTarget>>
let status: McpStatus
let token: string
let client: Client

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Calls a tool and returns its structured result; fails the test on a tool error. */
async function tool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(`${name}: ${JSON.stringify(res.content)}`)
  return res.structuredContent as T
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-mcp-'))
  target = await startTarget()
  // Assistants are looked for in a throwaway home: the test must never touch the real configs.
  mkdirSync(join(tmp, 'home', '.config', 'Claude'), { recursive: true })
  ctx = await launch(join(tmp, 'profile'), { SLINGER_MCP_CLIENTS_HOME: join(tmp, 'home') })
  const port = await freePort()
  status = await ctx.page.evaluate((p) => window.slinger.setMcpSettings({ enabled: true, port: p }), port)
  token = await ctx.page.evaluate(() => window.slinger.revealMcpToken())
  client = new Client({ name: 'e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(status.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
})

afterAll(async () => {
  await client?.close().catch(() => {})
  await ctx?.app.close()
  await target?.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('MCP server', () => {
  it('runs on 127.0.0.1 and lists the tools', async () => {
    expect(status).toMatchObject({ enabled: true, running: true, error: null })
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_tree', 'create_request', 'send_request', 'run_collection']))
  })

  it('builds a collection the window shows, and sends with a secret it never reveals', async () => {
    const { created: col } = await tool('create_collection', { name: 'Built by an assistant' })
    const { created: req } = await tool('create_request', {
      collection_id: col.id,
      name: 'Who am I',
      method: 'GET',
      url: `${target.url}/whoami`,
      headers: [{ key: 'X-Trace', value: 'mcp-e2e' }],
      auth: { type: 'bearer', token: '{{apiToken}}' },
    })
    await ctx.page.getByRole('treeitem', { name: /Built by an assistant/ }).waitFor()

    const { created: env } = await tool('create_environment', { name: 'MCP e2e' })
    await tool('set_variable', { environment_id: env.id, key: 'apiToken', value: 'sk-e2e-secret-41', secret: true })
    await tool('set_active_environment', { environment_id: env.id })
    const envs = await tool('list_environments')
    expect(JSON.stringify(envs)).not.toContain('sk-e2e-secret-41')

    const { response } = await tool('send_request', { request_id: req.id })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ trace: 'mcp-e2e', hasAuthorization: true })
    // The secret went over the wire, resolved inside Slinger...
    expect(target.requests.at(-1)!.headers.authorization).toBe('Bearer sk-e2e-secret-41')
    // ...but no tool result ever contained it.
    expect(JSON.stringify(await tool('get_request', { request_id: req.id }))).not.toContain('sk-e2e-secret-41')
    const { history } = await tool('list_history', { limit: 1 })
    expect(history[0]).toMatchObject({ method: 'GET', status: 200, request_id: req.id })
  })

  it('Connect writes Claude Desktop\'s config, and the command in it reaches Slinger without any token', async () => {
    const clients = await ctx.page.evaluate(() => window.slinger.connectMcpClient('claude-desktop'))
    expect(clients.find((c) => c.id === 'claude-desktop')).toMatchObject({ installed: true, state: 'connected' })
    const config = JSON.parse(readFileSync(join(tmp, 'home', '.config', 'Claude', 'claude_desktop_config.json'), 'utf8'))
    const entry = config.mcpServers.slinger as { command: string; args: string[]; env: Record<string, string> }
    expect(JSON.stringify(entry)).not.toContain(token)
    expect(entry.args[0]).toBe(join(tmp, 'profile', 'mcp', 'bridge.cjs'))

    // Start it the way Claude Desktop does: the command, its args and env, nothing else.
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...entry.env }
    delete env.SLINGER_MCP_URL
    delete env.SLINGER_MCP_TOKEN
    const child = spawn(entry.command, entry.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: string[] = []
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`)
    const answer = async (id: number) => {
      for (let i = 0; i < 100; i++) {
        const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id)
        if (hit) return hit
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`no answer for ${id}`)
    }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-e2e', version: '1' } } })
    expect((await answer(1)).result.serverInfo.name).toBe('slinger')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_requests', arguments: { query: 'who am i' } } })
    expect((await answer(2)).result.structuredContent.matches[0]).toMatchObject({ name: 'Who am I' })
    child.stdin.end()
    await new Promise((r) => child.on('exit', r))

    const after = await ctx.page.evaluate(() => window.slinger.disconnectMcpClient('claude-desktop'))
    expect(after.find((c) => c.id === 'claude-desktop')!.state).toBe('not-connected')
  })

  it('stops answering when turned off', async () => {
    await ctx.page.evaluate((p) => window.slinger.setMcpSettings({ enabled: false, port: p }), status.port)
    await expect(fetch(status.url, { method: 'POST' })).rejects.toThrow()
  })
})
