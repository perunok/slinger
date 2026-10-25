/**
 * A collection with thousands of requests: the sidebar renders only the rows in view (virtual scrolling) and still
 * behaves like the plain list: arrow keys / Home / End move the focus through every row, scrolling brings rows in,
 * filtering finds rows that were never rendered, and clicking opens a request.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launch, reloadApp, type Launched } from './support/app'

let tmp: string
let ctx: Launched
let page: Page

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-bigtree-'))
  ctx = await launch(join(tmp, 'profile'), { SLINGER_INSECURE_TEST_KEYCHAIN: '1' })
  page = ctx.page
}, 60_000)

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
})

const treeItems = () => page.evaluate(() => document.querySelectorAll('[role=tree] [role=treeitem]').length)

it('a 2,000-request collection renders only what is in view and stays fully navigable', async () => {
  const folders = Array.from({ length: 20 }, (_, f) => ({
    name: `Folder ${f}`,
    item: Array.from({ length: 100 }, (_, r) => ({ name: `Request ${f}-${r}`, request: { method: 'GET', url: { raw: `https://api.example.com/${f}/${r}` } } })),
  }))
  const text = JSON.stringify({ info: { name: 'Big collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: folders })
  const collectionId = await page.evaluate(async (txt) => {
    const w = (window as unknown as { slinger: { listWorkspaces(): Promise<Array<{ id: string }>>; importPostmanCollection(ws: string, t: string): Promise<{ collection: { id: string } }>; listFolders(id: string): Promise<Array<{ id: string }>> } }).slinger
    const ws = (await w.listWorkspaces())[0]!.id
    const { collection } = await w.importPostmanCollection(ws, txt)
    const ids = (await w.listFolders(collection.id)).map((f) => `folder:${f.id}`)
    localStorage.setItem('slinger.expanded', JSON.stringify([`collection:${collection.id}`, ...ids]))
    return collection.id
  }, text)
  expect(collectionId).toBeTruthy()
  await reloadApp(page)

  await page.getByTestId('tree-virtual').waitFor()
  expect(await treeItems()).toBeLessThan(150)

  // Keyboard: End reaches the very last row, Home the first, through rows that were not rendered.
  await page.getByRole('treeitem', { name: /Big collection/ }).focus()
  await page.keyboard.press('End')
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toContain('Request 19-99')
  await page.keyboard.press('Home')
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toContain('Big collection')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toContain('Request 0-0')

  // Scrolling brings rows in; the list stays small.
  await page.evaluate(() => {
    document.querySelector('[role=tree]')!.scrollTop = 1010 * 28
  })
  await page.getByRole('treeitem', { name: /Request 9-99\b/ }).waitFor()
  expect(await treeItems()).toBeLessThan(150)

  // Filtering finds a row that was never rendered; clearing brings the big list back.
  await page.locator('#tree-filter').fill('Request 17-42')
  await page.getByRole('treeitem', { name: /Request 17-42\b/ }).waitFor()
  await expect.poll(treeItems).toBeLessThan(10)
  await page.locator('#tree-filter').fill('')
  await page.getByTestId('tree-virtual').waitFor()

  // Clicking a row opens the request.
  await page.evaluate(() => {
    document.querySelector('[role=tree]')!.scrollTop = 0
  })
  await page.getByRole('treeitem', { name: /Request 0-5\b/ }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('[role=treeitem][aria-selected=true]')?.textContent ?? '')).toContain('Request 0-5')
  expect(ctx.problems).toEqual([])
}, 120_000)
