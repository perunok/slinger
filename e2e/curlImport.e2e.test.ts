/**
 * cURL import end to end: a curl command pasted into the Import dialog becomes a request in a new collection, opens in a
 * tab, and sending it reaches a local server with the method, headers and body the command had. A curl pasted into a
 * request's URL bar opens the Import dialog with it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, type Launched } from './support/app'

let tmp: string
let ctx: Launched
let page: Page
let server: Server
let base: string
const received: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = []

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-curl-'))
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ctx = await launch(join(tmp, 'profile'))
  page = ctx.page
}, 60_000)

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

describe('cURL import', () => {
  it('adds a pasted curl to a new collection, opens it, and sends what the command described', async () => {
    const curl = `curl -X POST '${base}/orders?dry=1' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Trace: e2e' \\
  -u ann:secret \\
  --compressed \\
  -d '{"item":"book","qty":2}'`
    await page.getByRole('button', { name: 'Import collection or environment' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await dialog.getByLabel('Or paste JSON or a cURL command').fill(curl)
    await dialog.getByTestId('curl-preview').waitFor()
    expect(await dialog.getByTestId('curl-request').textContent()).toContain(`${base}/orders?dry=1`)
    expect(await dialog.getByTestId('curl-summary').textContent()).toBe('2 headers · JSON body · Basic auth')
    await dialog.getByLabel('Collection', { exact: true }).selectOption({ label: 'New collection…' })
    await dialog.getByLabel('New collection name').fill('From cURL')
    await dialog.getByLabel('Request name').fill('Create order')
    await dialog.getByRole('button', { name: 'Add request' }).click()
    await dialog.waitFor({ state: 'detached' })

    await page.getByRole('tree', { name: 'Collections' }).getByRole('treeitem', { name: /Create order/ }).waitFor()
    await page.getByRole('tab', { name: /Create order/ }).waitFor()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => received.length).toBe(1)
    const [r] = received
    expect(r).toMatchObject({ method: 'POST', url: '/orders?dry=1', body: '{"item":"book","qty":2}' })
    expect(r!.headers['content-type']).toBe('application/json')
    expect(r!.headers['x-trace']).toBe('e2e')
    expect(r!.headers['authorization']).toBe(`Basic ${Buffer.from('ann:secret').toString('base64')}`)
  })

  it('a curl pasted into the URL bar opens the Import dialog with it', async () => {
    await page.keyboard.press('ControlOrMeta+t')
    const url = page.getByRole('textbox', { name: 'Request URL' })
    await url.click()
    // Clipboard access can be refused in automation: dispatch the paste event the URL bar listens to instead.
    await url.evaluate((el, text) => {
      const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : ''), types: ['text/plain'] } })
      el.dispatchEvent(e)
    }, `curl ${base}/ping`)
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await dialog.getByTestId('import-note').waitFor()
    expect(await dialog.getByTestId('import-note').textContent()).toContain('Detected pasted cURL command')
    expect(await dialog.getByTestId('curl-request').textContent()).toContain(`${base}/ping`)
    await page.keyboard.press('Escape')
  })

  it('logged no page errors', () => {
    expect(ctx.problems).toEqual([])
  })
})
