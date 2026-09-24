/**
 * Screenshot pass: seeds data over IPC, then captures the main view and the main dialogs in every
 * theme into test-results/screenshots/. Assertions are minimal (files exist, no page errors);
 * the point is to look at the images.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, launch, ROOT, type Launched } from './support/app'
import { startTarget } from './support/server'

const OUT = join(ROOT, 'test-results', 'screenshots')
const THEMES = ['light', 'dark', 'midnight', 'solarized', 'contrast']
let tmp: string
let ctx: Launched
let target: Awaited<ReturnType<typeof startTarget>>

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-shots-'))
  target = await startTarget()
  ctx = await launch(join(tmp, 'ud'))
  await ctx.page.evaluate(async (base) => {
    const s = window.slinger
    const ws = (await s.listWorkspaces())[0]!
    const env = await s.ensureDefaultEnvironment(ws.id)
    await s.upsertEnvironmentVariable({ environmentId: env.id, key: 'baseUrl', value: base, isSecret: false })
    await s.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 'shot-secret', isSecret: true })
    const col = await s.createCollection(ws.id, 'Payments API')
    const folder = await s.createFolder({ workspaceId: ws.id, collectionId: col.id, parentFolderId: null, name: 'Charges' })
    const doc = JSON.stringify({ headers: [{ key: 'Accept', value: 'application/json' }], body: null })
    await s.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: folder.id, name: 'List charges', method: 'GET', url: '{{baseUrl}}/v1/charges?limit=10', documentJson: doc })
    await s.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: null, name: 'Create charge', method: 'POST', url: '{{baseUrl}}/v1/charges', documentJson: doc })
    await s.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'first cut' })
  }, target.url)
  await ctx.page.reload()
  await ctx.page.getByRole('treeitem', { name: /Payments API/ }).waitFor()
})
afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  await target?.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('screenshots', () => {
  for (const theme of THEMES) {
    it(`captures ${theme}`, async () => {
      const { page, app } = ctx
      // Tokens hang off <html data-theme>; the Settings picker itself is exercised by the main e2e suite.
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
      const tree = page.getByRole('tree', { name: 'Collections' })
      if ((await tree.getByRole('treeitem', { name: /List charges/ }).count()) === 0) await tree.getByRole('treeitem', { name: /Charges/ }).click()
      await tree.getByRole('treeitem', { name: /Create charge/ }).click()
      await page.getByRole('button', { name: 'Send', exact: true }).click().catch(() => {})
      await page.waitForTimeout(400)
      await capture(app, join(OUT, `${theme}-main.png`))
      for (const [label, open, dialogName] of [
        ['environments', () => page.getByRole('button', { name: 'Manage environments' }).click(), 'Environments'],
        ['cloud', () => page.getByRole('button', { name: 'Cloud' }).click(), 'Cloud'],
        ['shortcuts', () => page.getByRole('button', { name: 'Keyboard shortcuts' }).click(), 'Keyboard shortcuts'],
      ] as const) {
        await open()
        await page.getByRole('dialog', { name: dialogName }).waitFor()
        await page.waitForTimeout(250)
        await capture(app, join(OUT, `${theme}-${label}.png`))
        await page.keyboard.press('Escape')
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
      }
      await page.getByRole('treeitem', { name: /Payments API/ }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Versions…' }).click()
      await page.getByRole('dialog', { name: /^Versions/ }).getByRole('option').first().click()
      await page.waitForTimeout(300)
      await capture(app, join(OUT, `${theme}-versions.png`))
      await page.keyboard.press('Escape')
      expect(existsSync(join(OUT, `${theme}-main.png`))).toBe(true)
    })
  }
  it('had no page errors', () => expect(ctx.problems).toEqual([]))
})
