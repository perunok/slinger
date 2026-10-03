/**
 * The window around the app: the custom title bar (default) and switching to the system one, and the new-release
 * notice against a local stand-in for GitHub's latest-release endpoint (SLINGER_UPDATE_FEED_URL). Steps run in order.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootSkeletonGone, launch, type Launched } from './support/app'

let tmp: string
let feed: Server
let feedUrl: string
let feedHits = 0
let ctx: Launched

async function start(): Promise<Launched> {
  ctx = await launch(join(tmp, 'profile'), { SLINGER_UPDATE_FEED_URL: feedUrl })
  // Release links go to the OS browser: record them instead.
  await ctx.app.evaluate(({ shell }) => {
    ;(globalThis as { opened?: string[] }).opened = []
    shell.openExternal = async (url: string) => void (globalThis as unknown as { opened: string[] }).opened.push(url)
  })
  return ctx
}
const opened = () => ctx.app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-window-'))
  feed = createServer((_req, res) => {
    feedHits++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v99.0.0', published_at: '2026-10-01T10:00:00Z', html_url: 'https://example.com/elsewhere', draft: false, prerelease: false }))
  })
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r))
  feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/repos/perunok/slinger/releases/latest`
  await start()
})

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  await new Promise((r) => feed.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

describe('window', () => {
  it('uses the custom title bar by default, with the application menu behind a button', async () => {
    const { page, app } = ctx
    await expect(page.locator('[data-titlebar]').getAttribute('data-custom-titlebar')).resolves.toBe('true')
    expect(await page.evaluate(() => window.slinger.getWindowChrome())).toEqual({
      platform: process.platform,
      titleBar: 'custom',
      preferredTitleBar: 'custom',
    })
    if (process.platform !== 'darwin') {
      await page.getByRole('button', { name: 'Application menu' }).click()
      await page.keyboard.press('Escape')
    }
    // The drag region never swallows the controls in the bar.
    const regions = await page.evaluate(() => {
      const bar = document.querySelector('[data-titlebar]')!
      const region = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region')
      return { bar: region(bar), buttons: Array.from(bar.querySelectorAll('button, select'), region) }
    })
    expect(regions.bar).toBe('drag')
    expect(new Set(regions.buttons)).toEqual(new Set(['no-drag']))
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  })

  it('announces a newer release once, linking to its GitHub release page', async () => {
    const { page } = ctx
    // The automatic check runs a few seconds after startup.
    await page.getByText('Slinger 99.0.0 is available').waitFor({ timeout: 20_000 })
    expect(feedHits).toBe(1)
    await page.getByRole('button', { name: 'View release' }).click()
    expect(await opened()).toEqual(['https://github.com/perunok/slinger/releases/tag/v99.0.0'])
  })

  it('Help > Check for Updates… asks again right away', async () => {
    const { app, page } = ctx
    await app.evaluate(({ Menu }) => {
      type Item = { label: string; submenu?: { items: Item[] } | null; click: () => void }
      const find = (items: Item[]): Item | undefined => {
        for (const i of items) {
          if (i.label === 'Check for Updates…') return i
          const sub = i.submenu && find(i.submenu.items)
          if (sub) return sub
        }
      }
      find(Menu.getApplicationMenu()!.items as unknown as Item[])!.click()
    })
    await expect.poll(() => page.getByText('Slinger 99.0.0 is available').count()).toBe(1)
    expect(feedHits).toBe(2)
  })

  it('switches to the system title bar by reopening the window, and keeps it after a restart', async () => {
    let { app, page } = ctx
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('checkbox', { name: 'Use the system title bar' }).check()
    const next = app.waitForEvent('window')
    await page.getByRole('button', { name: 'Reopen window' }).click()
    page = await next
    await bootSkeletonGone(page)
    expect(await page.evaluate(() => window.slinger.getWindowChrome())).toMatchObject({ titleBar: 'system', preferredTitleBar: 'system' })
    expect(await page.locator('[data-titlebar]').getAttribute('data-custom-titlebar')).toBeNull()
    expect(await page.getByRole('button', { name: 'Application menu' }).count()).toBe(0)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    await app.close()
    ;({ app, page } = await start())
    expect(await page.evaluate(() => window.slinger.getWindowChrome())).toMatchObject({ titleBar: 'system' })
    // Already announced: no second notification for the same release after a restart.
    await page.waitForTimeout(10_000)
    expect(await page.getByText('Slinger 99.0.0 is available').count()).toBe(0)
  })

  it('logged no page errors', () => {
    expect(ctx.problems).toEqual([])
  })
})
