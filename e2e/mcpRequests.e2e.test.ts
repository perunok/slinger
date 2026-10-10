/**
 * MCP requests end to end: the real app as an MCP client. A real SDK McpServer runs inside the test process over
 * Streamable HTTP on 127.0.0.1; an MCP request is created from the sidebar, connects, runs a tool picked from the
 * server's list (arguments through the generated form), reads a resource, and lands in History. Then a stdio request
 * (electron/__tests__/fixtures/mcp-stdio-server.mjs, started by main): the first Run asks to allow the command, Allow
 * runs it; the collection runner runs both, and quitting the app stops the stdio server process. Steps run in order and share one app.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { z } from 'zod'
import { capture, launch, ROOT, type Launched } from './support/app'

const FIXTURE = join(ROOT, 'electron', '__tests__', 'fixtures', 'mcp-stdio-server.mjs')
const SHOTS = join(ROOT, 'test-results', 'e2e')

let tmp: string
let ctx: Launched
let page: Page
let server: Awaited<ReturnType<typeof startMcpServer>>

/** An MCP server with one tool and one resource, one SDK server per Streamable HTTP session. */
async function startMcpServer() {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const sockets = new Set<Socket>()
  const calls: Array<{ text: string; times: number }> = []
  const build = () => {
    const mcp = new McpServer({ name: 'e2e-server', version: '3.1.4', title: 'E2E server' }, { instructions: 'Repeat things.' })
    mcp.registerTool(
      'repeat',
      {
        description: 'Repeats a text',
        inputSchema: { text: z.string().describe('What to repeat'), times: z.number().int().min(1).max(5) },
        outputSchema: { result: z.string() },
      },
      async ({ text, times }) => {
        calls.push({ text, times })
        const result = Array.from({ length: times }, () => text).join('-')
        return { content: [{ type: 'text', text: result }], structuredContent: { result } }
      },
    )
    mcp.registerResource('readme', 'e2e://readme', { mimeType: 'text/plain' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'The e2e readme' }],
    }))
    return mcp
  }
  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return void res.writeHead(404).end()
      const sid = req.headers['mcp-session-id']
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined
      if (!transport) {
        if (sid) return void res.writeHead(404).end()
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => void sessions.set(id, t) })
        await build().connect(t)
        transport = t
      }
      await transport.handleRequest(req, res)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  http.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    calls,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => http.close(() => r()))
    },
  }
}

/** Types into a CodeMirror-backed input, replacing what is there. */
async function typeInto(locator: ReturnType<Page['getByRole']>, text: string) {
  await locator.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}

const tree = () => page.getByRole('tree', { name: 'Collections' })
const item = (name: string | RegExp) => tree().getByRole('treeitem', { name })
const bar = () => page.getByRole('group', { name: 'MCP server' })
const result = () => page.getByRole('region', { name: 'MCP result' })

async function newMcpRequest(collection: RegExp, name: string) {
  await item(collection).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New MCP request' }).click()
  await page.getByRole('dialog').getByRole('textbox', { name: 'Request name' }).fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('tab', { name: new RegExp(name) }).waitFor()
  await bar().waitFor()
}

async function run() {
  await bar().getByRole('button', { name: 'Run', exact: true }).click()
}

/** Running processes started from the stdio fixture (a server left behind after quitting would show up here). */
function fixtureProcesses(): string[] {
  return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(FIXTURE))
}

const workspaceId = () => page.evaluate(async () => (await window.slinger.listWorkspaces())[0]!.id)

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-mcp-requests-'))
  server = await startMcpServer()
  ctx = await launch(join(tmp, 'profile'))
  page = ctx.page
})

beforeEach((t) => {
  onTestFailed(async () => {
    const name = t.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    await capture(ctx.app, join(SHOTS, `FAILED-mcp-${name}.png`)).catch(() => {})
    console.log(`[e2e] failure screenshot: ${join(SHOTS, `FAILED-mcp-${name}.png`)}`)
  })
})

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  await server?.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('MCP requests', () => {
  it('creates an MCP request from the sidebar, connects and lists what the server offers', async () => {
    await page.getByRole('button', { name: 'New collection' }).first().click()
    await page.getByRole('dialog').getByRole('textbox', { name: 'Collection name' }).fill('MCP e2e')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await item(/^MCP e2e/).waitFor()

    await newMcpRequest(/^MCP e2e/, 'Repeat tool')
    await expect(bar().getByRole('combobox', { name: 'Transport' }).inputValue()).resolves.toBe('http')
    await typeInto(page.getByRole('textbox', { name: 'Server URL' }), server.url)
    await bar().getByRole('button', { name: 'Connect' }).click()
    await bar().getByRole('img', { name: 'Connected' }).waitFor()
    await page.getByTestId('mcp-capability-list').getByRole('button', { name: /repeat/ }).waitFor()

    await page.getByRole('tab', { name: /^Server/ }).click()
    await page.getByText('Repeat things.').waitFor()
    await page.getByRole('tab', { name: /^Call/ }).click()
  })

  it('picks the tool, fills its form and runs it; the result, the message log and the server agree', async () => {
    await page.getByTestId('mcp-capability-list').getByRole('button', { name: /repeat/ }).click()
    await typeInto(page.getByRole('textbox', { name: 'text', exact: true }), 'hey')
    await typeInto(page.getByRole('textbox', { name: 'times', exact: true }), '3')
    await run()
    await expect.poll(() => result().getByTestId('mcp-status-chip').textContent()).toBe('OK')
    await result().getByText('hey-hey-hey').first().waitFor()
    expect(server.calls.at(-1)).toEqual({ text: 'hey', times: 3 })

    // The run used the tab's connection, so its exchange is in the message log.
    await result().getByRole('tab', { name: /Messages/ }).click()
    await expect.poll(() => result().innerText()).toContain('tools/call')
    await result().getByRole('tab', { name: /Result/ }).click()
  })

  it('saves the request as an MCP document', async () => {
    await bar().getByRole('button', { name: 'Save', exact: true }).click()
    await bar().getByRole('button', { name: 'Save', exact: true }).and(page.locator('[disabled]')).waitFor()
    const saved = await page.evaluate(async (ws) => {
      const s = window.slinger
      const col = (await s.listCollections(ws)).find((c) => c.name === 'MCP e2e')!
      const req = (await s.listRequests(col.id)).find((r) => r.name === 'Repeat tool')!
      return { method: req.method, url: req.url, doc: JSON.parse(req.documentJson) }
    }, await workspaceId())
    expect(saved).toMatchObject({ method: 'MCP', url: server.url, doc: { mcp: { v: 1, transport: 'http', operation: 'tools/call', tool: 'repeat' } } })
    expect(JSON.parse(saved.doc.mcp.arguments)).toEqual({ text: 'hey', times: 3 })
  })

  it('reads a resource', async () => {
    await page.getByRole('combobox', { name: 'Operation' }).selectOption('resources/read')
    await typeInto(page.getByRole('textbox', { name: 'Resource URI' }), 'e2e://readme')
    await run()
    await result().getByText('The e2e readme').first().waitFor()
    await expect.poll(() => result().getByTestId('mcp-status-chip').textContent()).toBe('OK')
  })

  it('records each call in History with its operation, and the row opens the request', async () => {
    const rows = await page.evaluate(async (ws) => (await window.slinger.listHistory(ws)).slice(0, 2), await workspaceId())
    expect(rows.map((r) => ({ method: r.method, url: r.url, detail: r.detail, ok: r.ok, statusCode: r.statusCode }))).toEqual([
      { method: 'MCP', url: server.url, detail: 'resources/read e2e://readme', ok: true, statusCode: null },
      { method: 'MCP', url: server.url, detail: 'tools/call repeat', ok: true, statusCode: null },
    ])
    await page.getByRole('tab', { name: 'History' }).click()
    const panel = page.getByRole('tabpanel', { name: 'History' })
    await expect.poll(() => panel.innerText()).toContain('tools/call repeat')
    expect(await panel.getByTestId('history-mcp-detail').allTextContents()).toEqual(expect.arrayContaining(['tools/call repeat', 'resources/read e2e://readme']))
    await page.getByRole('tab', { name: 'Collections' }).click()
  })

  it('a stdio command asks to be allowed on the first Run, then runs', async () => {
    await newMcpRequest(/^MCP e2e/, 'Stdio echo')
    await bar().getByRole('combobox', { name: 'Transport' }).selectOption('stdio')
    await typeInto(page.getByRole('textbox', { name: 'Command', exact: true }), process.execPath)
    await typeInto(page.getByRole('textbox', { name: 'Arguments', exact: true }), FIXTURE)
    await page.getByRole('textbox', { name: 'Tool', exact: true }).fill('echo')
    await typeInto(page.getByRole('textbox', { name: 'Tool arguments (JSON)' }), '{"text": "from e2e"}')

    await run()
    const dialog = page.getByRole('dialog', { name: /Allow Slinger to run this command/ })
    await dialog.waitFor()
    await expect(dialog.getByTestId('trust-command').textContent()).resolves.toBe(process.execPath)
    await expect(dialog.getByTestId('trust-args').innerText()).resolves.toContain(FIXTURE)
    // Nothing started before the user allowed it.
    await expect.poll(() => result().getByTestId('mcp-status-chip').textContent()).toBe('Error')
    await dialog.getByRole('button', { name: 'Allow and connect' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await result().getByText('echo: from e2e').first().waitFor()
    await expect.poll(() => result().getByTestId('mcp-status-chip').textContent()).toBe('OK')
    await bar().getByRole('img', { name: 'Connected' }).waitFor()

    // The server's stderr reaches the Logs view.
    await result().getByRole('tab', { name: /Logs/ }).click()
    await expect.poll(() => result().innerText()).toContain('fixture started')
    await result().getByRole('tab', { name: /Result/ }).click()
  })

  it('the collection runner runs both saved MCP requests (the allowed command included)', async () => {
    await bar().getByRole('button', { name: 'Save', exact: true }).click()
    await bar().getByRole('button', { name: 'Save', exact: true }).and(page.locator('[disabled]')).waitFor()
    const calls = server.calls.length
    await item(/^MCP e2e/).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Run collection…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Run 2 requests/ }).click()
    await expect.poll(() => dialog.getByTestId('summary').innerText(), { timeout: 15_000 }).toMatch(/^2 passed, 0 failed/)
    expect(server.calls.slice(calls)).toEqual([{ text: 'hey', times: 3 }])
    const rows = await page.evaluate(async (ws) => (await window.slinger.listHistory(ws)).slice(0, 2), await workspaceId())
    expect(rows.map((r) => [r.detail, r.ok])).toEqual(expect.arrayContaining([['tools/call repeat', true], ['tools/call echo', true]]))
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  })

  it('keeps the renderer free of errors', () => {
    expect(ctx.problems).toEqual([])
  })

  it('quitting stops the stdio server it started', async () => {
    // The tab's connection and the runner's shared one (closed after 2 minutes without use).
    expect(fixtureProcesses()).toHaveLength(2)
    await ctx.app.close()
    await expect.poll(fixtureProcesses, { timeout: 10_000 }).toEqual([])
  })
})
