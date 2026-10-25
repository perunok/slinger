/**
 * OpenAPI end to end in the real app: a YAML document pasted into the Import dialog becomes a collection in folders by
 * tag, its generated examples are served by a mock server at once, and the collection exports back as OpenAPI 3.1.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, stubDialogs, type Launched } from './support/app'

let tmp: string
let exportDir: string
let ctx: Launched
let page: Page
let port: number
const SPEC = readFileSync(join(__dirname, '../electron/__tests__/openapi/fixtures/shop-3.0.yaml'), 'utf8')

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return p
}
function get(path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
      .on('error', reject)
      .end()
  })
}
const tree = () => page.getByRole('tree', { name: 'Collections' })

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-openapi-'))
  exportDir = join(tmp, 'exports')
  mkdirSync(exportDir)
  port = await freePort()
  ctx = await launch(join(tmp, 'profile'), { SLINGER_INSECURE_TEST_KEYCHAIN: '1' })
  page = ctx.page
}, 60_000)

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
})

describe('OpenAPI', () => {
  it('imports a pasted YAML document as a collection in folders by tag', async () => {
    await page.getByRole('button', { name: 'Import collection or environment' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await dialog.getByLabel('Or paste JSON or a cURL command').fill(SPEC)
    await dialog.getByTestId('openapi-preview').waitFor()
    expect(await dialog.getByTestId('openapi-operations').textContent()).toContain('7 requests')
    await dialog.getByRole('button', { name: 'Import API' }).click()
    await dialog.waitFor({ state: 'detached' })
    await tree().getByRole('treeitem', { name: /^Shop API/ }).waitFor()
    await tree().getByRole('treeitem', { name: /^pets/ }).waitFor()
    await tree().getByRole('treeitem', { name: /^orders/ }).waitFor()
    expect(await page.evaluate(async () => {
      const w = (window as unknown as { slinger: { listWorkspaces(): Promise<Array<{ id: string }>>; listCollections(id: string): Promise<Array<{ id: string; name: string }>>; getOpenApiLink(id: string): Promise<{ title: string } | null> } }).slinger
      const ws = (await w.listWorkspaces())[0]!.id
      const col = (await w.listCollections(ws)).find((c) => c.name === 'Shop API')!
      return (await w.getOpenApiLink(col.id))?.title
    })).toBe('Shop API')
  })

  it('a mock server answers with the examples generated from the document', async () => {
    await tree().getByRole('treeitem', { name: /^Shop API/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mock server…' }).click()
    const dialog = page.getByTestId('mock-server-dialog')
    await dialog.getByLabel('Port').fill(String(port))
    await dialog.getByTestId('mock-start').click()
    await expect.poll(() => dialog.getByTestId('mock-url').textContent()).toBe(`http://127.0.0.1:${port}`)
    const list = await get('/pets?status=available')
    expect(list.status).toBe(200)
    expect(JSON.parse(list.body).items[0]).toMatchObject({ id: 7, name: 'string', kind: 'cat' })
    const pet = await get('/pets/7')
    expect(JSON.parse(pet.body)).toMatchObject({ id: 7 })
    expect((await get('/health')).body).toBe('ok')
    await page.keyboard.press('Escape')
  })

  it('a response from the mock is checked against the document (Spec chip)', async () => {
    // Point the collection's baseUrl at the mock server, then send "Get a pet".
    await page.evaluate(async (url) => {
      const w = (window as unknown as { slinger: Record<string, (...a: unknown[]) => Promise<unknown>> }).slinger
      const ws = ((await w.listWorkspaces!()) as Array<{ id: string }>)[0]!.id
      const col = ((await w.listCollections!(ws)) as Array<{ id: string; name: string }>).find((c) => c.name === 'Shop API')!
      const vars = (await w.listCollectionVariables!(col.id)) as Array<{ key: string; value: string; enabled: boolean; description: string | null }>
      await w.replaceCollectionVariables!(col.id, vars.map((v) => ({ key: v.key, value: v.key === 'baseUrl' ? url : v.value, enabled: v.enabled, description: v.description })))
    }, `http://127.0.0.1:${port}`)
    await page.reload()
    const pets = tree().getByRole('treeitem', { name: /^pets/ })
    if ((await pets.getAttribute('aria-expanded')) !== 'true') await pets.click()
    await tree().getByRole('treeitem', { name: /Get a pet$/ }).click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const chip = page.getByTestId('spec-chip')
    await chip.waitFor()
    await expect.poll(() => chip.getAttribute('data-status')).toBe('valid')
    expect(await chip.textContent()).toContain('Matches spec')
    // Stop the mock server again.
    await tree().getByRole('treeitem', { name: /^Shop API/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mock server…' }).click()
    await page.getByTestId('mock-server-dialog').getByRole('button', { name: 'Stop' }).click()
    await page.keyboard.press('Escape')
  })

  it('exports the collection as OpenAPI 3.1 YAML with the same operations', async () => {
    await stubDialogs(ctx.app, { directory: exportDir })
    await tree().getByRole('treeitem', { name: /^Shop API/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Export…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Export collection' })
    await dialog.getByLabel('Format').selectOption({ label: 'OpenAPI 3.1 (.yaml)' })
    await dialog.getByRole('button', { name: /Choose folder/ }).click()
    await dialog.getByRole('button', { name: 'Save to file' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => readdirSync(exportDir).some((f) => f.endsWith('.openapi.yaml'))).toBe(true)
    const doc = yaml.load(readFileSync(join(exportDir, readdirSync(exportDir).find((f) => f.endsWith('.openapi.yaml'))!), 'utf8')) as {
      openapi: string
      paths: Record<string, Record<string, unknown>>
    }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths).sort()).toEqual(['/health', '/orders', '/pets', '/pets/{petId}', '/pets/{petId}/photo'])
    expect(Object.keys(doc.paths['/pets/{petId}']!).sort()).toEqual(['delete', 'get'])
  })

  it('updates the collection from a new version of the document (review, then apply)', async () => {
    const v2 = readFileSync(join(__dirname, '../electron/__tests__/openapi/fixtures/shop-3.0-v2.yaml'), 'utf8')
    await tree().getByRole('treeitem', { name: /^Shop API/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'OpenAPI…' }).click()
    const dialog = page.getByTestId('openapi-dialog')
    await dialog.getByTestId('openapi-link').waitFor()
    await page.getByRole('button', { name: 'Update from source' }).click()
    // The document was pasted: Slinger asks for the new version.
    await dialog.getByRole('radio', { name: 'Paste' }).check()
    await dialog.getByLabel('Document text').fill(v2)
    await page.getByRole('button', { name: 'Review changes' }).click()
    await page.getByRole('button', { name: 'Apply' }).waitFor()
    expect(await dialog.textContent()).toContain('Adjust stock')
    await page.getByRole('button', { name: 'Apply' }).click()
    await dialog.getByTestId('openapi-result').waitFor()
    expect(await dialog.getByTestId('openapi-result').textContent()).toMatch(/\d+ added/)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await tree().getByRole('treeitem', { name: /^stock/ }).waitFor()
  })

  it('logged no page errors', () => {
    expect(ctx.problems).toEqual([])
  })
})
