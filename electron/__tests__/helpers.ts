import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase } from '../db/database'
import { createIpcApi } from '../ipc/api'
import { createCore, type Core } from '../services/core'
import { ExportFiles } from '../services/exportFiles'
import { MemorySecretStore } from '../services/secrets'
import type { HttpRequestInput } from '../../shared/types'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))
export const SAMPLE_COLLECTION = fileURLToPath(new URL('../../example-postman-collection.json', import.meta.url))

export interface TestEnv {
  core: Core
  secrets: MemorySecretStore
  api: ReturnType<typeof createIpcApi>
  exportDir: string
  opened: string[]
  picked: { result: string | null; calls: unknown[] }
  cleanup(): void
}

/** Fresh in-memory database with all migrations applied, an in-memory keychain and a temp export dir. */
export function makeEnv(): TestEnv {
  const db = openDatabase(':memory:')
  const secrets = new MemorySecretStore()
  const exportDir = mkdtempSync(join(tmpdir(), 'slinger-export-'))
  const core = createCore({ db, secrets, migrationsDir: MIGRATIONS_DIR, exportFiles: new ExportFiles(exportDir) })
  const opened: string[] = []
  const picked: { result: string | null; calls: unknown[] } = { result: null, calls: [] }
  const api = createIpcApi(core, {
    appVersion: '0.0.0-test',
    openExternal: async (url) => void opened.push(url),
    chooseDirectory: async () => exportDir,
    pickFile: async (options) => (picked.calls.push(options), picked.result),
  })
  return {
    core,
    secrets,
    api,
    exportDir,
    opened,
    picked,
    cleanup() {
      core.authCallbacks.closeAll()
      db.close()
      rmSync(exportDir, { recursive: true, force: true })
    },
  }
}

export const DOC = JSON.stringify({ headers: [], body: null })

/** Workspace > collection scaffold used by most tests. */
export async function scaffold(env: TestEnv) {
  const workspace = await env.api.createWorkspace('Test WS')
  const collection = await env.api.createCollection(workspace.id, 'Col')
  return { workspace, collection }
}

export const NIL_UUID = '00000000-0000-4000-8000-000000000000'

export interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

/** Local HTTP server for executor tests (real sockets, no mocks). */
export async function startTestServer() {
  const requests: Recorded[] = []
  const sockets = new Set<import('node:net').Socket>()
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      requests.push(recorded)
      const path = (req.url ?? '').split('?')[0]
      if (path === '/binary') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return void res.end(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]))
      }
      if (path === '/latin1') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=iso-8859-1' })
        return void res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])) // "café" in latin-1
      }
      if (path === '/slow') return // never answers; the client must cancel or time out
      if (path === '/delay') {
        return void setTimeout(() => {
          res.writeHead(200)
          res.end('late')
        }, 150)
      }
      if (path === '/status/500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        return void res.end('boom')
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ method: recorded.method, url: recorded.url, ok: true }))
    })
  }
  const server: Server = createServer(handler)
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hostPort: `127.0.0.1:${port}`,
    requests,
    last: () => requests[requests.length - 1]!,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

export const baseHttp = (workspaceId: string, over: Partial<HttpRequestInput> & { url: string }): HttpRequestInput => ({
  method: 'GET',
  headers: [],
  auth: { kind: 'none' },
  body: { mode: 'none' },
  workspaceId,
  ...over,
})

/** A localhost port with nothing listening (fetch blocks well-known ports like 1, so grab a free one). */
export async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return port
}

/** Simulates the user choosing `path` in the native file dialog (the only way to grant file access). */
export async function pickAndGrant(env: TestEnv, path: string): Promise<string | null> {
  env.picked.result = path
  return env.api.pickFile()
}
