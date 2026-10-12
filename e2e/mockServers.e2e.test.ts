/**
 * Mock servers end to end, in the real app: a collection with saved examples (seeded through the API) is served from the
 * collection menu's Mock server dialog, then called from the test process like any HTTP client: query and body
 * selection, CORS for a page on this computer (and a refused preflight from elsewhere), the request inspector, the delay,
 * and "Start again when Slinger starts" across a restart. Steps run in order and share one profile.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, type Launched } from './support/app'

let tmp: string
let ctx: Launched
let page: Page
let port: number
const base = () => `http://127.0.0.1:${port}`

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const p = (probe.address() as AddressInfo).port
  await new Promise((r) => probe.close(r))
  return p
}

/** A raw HTTP call (fetch may not set Origin). */
function raw(o: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; ms: number }>((resolve, reject) => {
    const t0 = Date.now()
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }))
    })
    req.on('error', reject)
    req.end(o.body)
  })
}

const json = { key: 'Content-Type', value: 'application/json' }

async function seed(): Promise<void> {
  await page.evaluate(
    async ({ json }) => {
      const ws = (await window.slinger.listWorkspaces())[0]!.id
      const col = await window.slinger.createCollection(ws, 'Shop API')
      const doc = (responses: unknown[]) => JSON.stringify({ responses })
      await window.slinger.createRequest({
        workspaceId: ws,
        collectionId: col.id,
        name: 'List items',
        method: 'GET',
        url: '{{baseUrl}}/items',
        documentJson: doc([
          { name: 'All', code: 200, status: 'OK', header: [json], body: '["a","b"]' },
          { name: 'Page 2', originalRequest: { method: 'GET', url: '{{baseUrl}}/items?page=2' }, code: 200, header: [json], body: '["c"]' },
        ]),
      })
      await window.slinger.createRequest({
        workspaceId: ws,
        collectionId: col.id,
        name: 'Login',
        method: 'POST',
        url: '{{baseUrl}}/login',
        documentJson: doc([
          {
            name: 'Welcome',
            originalRequest: { method: 'POST', url: '{{baseUrl}}/login', body: { mode: 'raw', raw: '{"user":"ann","pass":"right"}' } },
            code: 200,
            header: [json],
            body: '{"token":"t-1"}',
          },
          {
            name: 'Denied',
            originalRequest: { method: 'POST', url: '{{baseUrl}}/login', body: { mode: 'raw', raw: '{"user":"ann","pass":"wrong"}' } },
            code: 401,
            status: 'Unauthorized',
            header: [json],
            body: '{"error":"denied"}',
          },
        ]),
      })
    },
    { json },
  )
  await page.reload()
  await page.getByRole('tree', { name: 'Collections' }).getByRole('treeitem', { name: /Shop API/ }).waitFor()
}

const dialog = () => page.getByTestId('mock-server-dialog')

async function openDialog(): Promise<void> {
  await page.getByRole('tree', { name: 'Collections' }).getByRole('treeitem', { name: /Shop API/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mock server…' }).click()
  await dialog().waitFor()
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-mock-'))
  port = await freePort()
  ctx = await launch(join(tmp, 'profile'))
  page = ctx.page
}, 60_000)

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
})

describe('mock servers', () => {
  it('starts from the collection menu on the chosen port', async () => {
    await seed()
    await openDialog()
    await dialog().getByLabel('Port').fill(String(port))
    await dialog().getByTestId('mock-start').click()
    await expect.poll(() => dialog().getByTestId('mock-url').textContent()).toBe(base())
    expect(await dialog().getByTestId('mock-summary').textContent()).toContain('4 saved examples')
  })

  it('answers by path, query parameters and request body', async () => {
    expect(JSON.parse((await raw({ path: '/items' })).body)).toEqual(['a', 'b'])
    expect(JSON.parse((await raw({ path: '/items?page=2' })).body)).toEqual(['c'])
    expect(JSON.parse((await raw({ path: '/items?page=7' })).body)).toEqual(['a', 'b'])
    const login = (body: string) => raw({ method: 'POST', path: '/login', headers: { 'Content-Type': 'application/json' }, body })
    expect((await login('{ "pass": "wrong", "user": "ann" }')).status).toBe(401)
    expect((await login('{"user":"ann","pass":"right"}')).status).toBe(200)
    expect((await raw({ path: '/nothing' })).status).toBe(404)
  })

  it('lets a page on this computer call it (CORS) and refuses a preflight from another website', async () => {
    const pre = await raw({ method: 'OPTIONS', path: '/login', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    const get = await raw({ path: '/items', headers: { Origin: 'http://localhost:5173' } })
    expect(get.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    const evil = await raw({ method: 'OPTIONS', path: '/login', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
    expect(evil.status).toBe(403)
    // Allowing any website applies to the running server at once.
    await dialog().getByTestId('mock-cors').check()
    await expect
      .poll(async () => (await raw({ method: 'OPTIONS', path: '/login', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST' } })).status)
      .toBe(204)
    await dialog().getByTestId('mock-cors').uncheck()
  })

  it('shows what a request sent and what was answered, with credentials shortened', async () => {
    await raw({ method: 'POST', path: '/login?src=e2e', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer very-secret-token-123' }, body: '{"user":"ann","pass":"right"}' })
    const row = dialog().getByTestId('mock-log-row').first()
    await expect.poll(() => row.textContent()).toContain('/login?src=e2e')
    await row.click()
    const details = page.getByTestId('mock-request-details')
    await details.waitFor()
    const text = (await details.textContent()) ?? ''
    expect(text).toContain('POST')
    expect(text).toContain('src')
    expect(text).toContain('"pass": "right"')
    expect(text).toContain('Welcome')
    expect(text).not.toContain('very-secret-token-123')
    expect(await page.getByTestId('mock-response-status').textContent()).toContain('200')
  })

  it('waits the delay before answering', async () => {
    const delay = dialog().getByTestId('mock-delay')
    await delay.fill('400')
    await delay.press('Enter')
    await expect.poll(async () => (await raw({ path: '/items' })).ms, { timeout: 8_000 }).toBeGreaterThanOrEqual(380)
    await delay.fill('0')
    await delay.press('Enter')
    await expect.poll(async () => (await raw({ path: '/items' })).ms).toBeLessThan(380)
  })

  it('starts again when Slinger starts, on the same port', async () => {
    await page.keyboard.press('Escape')
    await ctx.app.close()
    await expect(raw({ path: '/items' })).rejects.toThrow()
    ctx = await launch(join(tmp, 'profile'))
    page = ctx.page
    await expect.poll(async () => (await raw({ path: '/items' }).catch(() => ({ status: 0 }))).status, { timeout: 15_000 }).toBe(200)
    expect(await page.evaluate(() => window.slinger.listMockServers().then((l) => l.map((s) => [s.collectionName, s.options])))).toEqual([
      ['Shop API', { cors: 'local', delayMs: 0 }],
    ])
    // Stopped by the user: not started again next time.
    await openDialog()
    await dialog().getByTestId('mock-stop').click()
    await expect.poll(() => page.evaluate(() => window.slinger.listMockServers().then((l) => l.length))).toBe(0)
    await ctx.app.close()
    ctx = await launch(join(tmp, 'profile'))
    page = ctx.page
    await page.waitForTimeout(2_000)
    expect(await page.evaluate(() => window.slinger.listMockServers().then((l) => l.length))).toBe(0)
  })

  it('logged no page errors', () => {
    expect(ctx.problems).toEqual([])
  })
})
