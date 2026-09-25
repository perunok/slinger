/**
 * Cloud account + publish against a REAL slinger-admin server: device-flow sign-in (main process polls, tokens
 * stay in the main process), publish uploads the workspace, session restore after a restart, sign-out.
 * Skipped unless SLINGER_E2E_CLOUD_URL is set, e.g.
 *
 *   SLINGER_E2E_CLOUD_URL=http://127.0.0.1:18080 \
 *   SLINGER_E2E_CLOUD_EMAIL=admin@example.com SLINGER_E2E_CLOUD_PASSWORD=dev-only-passphrase-1 \
 *   npm run test:e2e:run -- e2e/cloud
 *
 * See slinger-admin/server/README.md for starting the server (Postgres in docker). The two-profile sync flow is in
 * sync.e2e.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { launch, type Launched } from './support/app'
import { BASE, closeDialog, openCloud, signInThroughUi } from './support/cloud'

describe.skipIf(!BASE)('cloud account and publish against slinger-admin', () => {
  let tmp: string
  let ctx: Launched
  let page: Page
  const wsName = `E2E ${Date.now()}`

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'slinger-cloud-'))
    ctx = await launch(join(tmp, 'ud'))
    page = ctx.page
    await ctx.app.evaluate(({ shell }) => {
      shell.openExternal = (async () => undefined) as never // never open a real browser
    })
    await page.evaluate(async (name) => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      await window.slinger.renameWorkspace(ws.id, name)
      const col = await window.slinger.createCollection(ws.id, 'Published collection')
      await window.slinger.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: null, name: 'Ping', method: 'GET', url: 'https://example.test/ping', documentJson: '{}' })
    }, wsName)
    await page.reload()
    await page.getByRole('combobox', { name: 'Workspace' }).waitFor()
  })
  afterAll(async () => {
    await ctx?.app.close().catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
  })

  it('signs in through the device flow (the renderer never sees tokens)', async () => {
    await signInThroughUi(page)
    // The renderer cannot read the token keychain entries any more.
    const leaked = await page.evaluate(async (base) => window.slinger.secureStoreGet(`slinger.cloud.tokens:${base}`).then(() => 'readable', () => 'blocked'), BASE!)
    expect(leaked).toBe('blocked')
  })

  it('publishes the local workspace: uploads its content and links it', async () => {
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await dialog.getByRole('button', { name: /Publish to cloud/ }).click()
    const publish = page.getByRole('dialog', { name: 'Publish to cloud' })
    await expect.poll(() => publish.getByTestId('publish-counts').innerText()).toContain('1 collection with 1 request')
    await publish.getByRole('button', { name: 'Publish' }).click()
    await expect.poll(() => publish.innerText(), { timeout: 60_000 }).toContain('Published.')
    await publish.getByRole('button', { name: 'Done' }).click()
    await expect.poll(() => dialog.getByTestId('sync-panel').innerText()).toContain(`Synced with ${wsName}`)
    await expect.poll(() => dialog.getByRole('list', { name: 'Cloud workspaces' }).innerText()).toContain(wsName)
    const status = await page.evaluate(async () => (await window.slinger.listSyncStatuses())[0]!)
    expect(status).toMatchObject({ linked: true, role: 'owner', pendingChanges: 0, openConflicts: 0, initialSyncPending: false })
    // Cloud traffic never shows up in the history.
    const history = await page.evaluate(async () => window.slinger.listHistory((await window.slinger.listWorkspaces())[0]!.id))
    expect(history).toEqual([])
  })

  it('the status chip reflects the synced state and offers Sync now', async () => {
    await closeDialog(page, 'Cloud')
    const chip = page.getByTestId('sync-chip')
    await expect.poll(() => chip.getAttribute('data-kind')).toBe('idle')
    await chip.click()
    await page.getByRole('button', { name: 'Sync now' }).click()
    await expect.poll(() => chip.getAttribute('data-kind')).toBe('idle')
    await page.keyboard.press('Escape')
  })

  it('restores the session and the link after a restart (tokens come from the keychain)', async () => {
    await ctx.app.close()
    ctx = await launch(join(tmp, 'ud'))
    page = ctx.page
    await openCloud(page)
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await expect.poll(() => dialog.innerText(), { timeout: 15_000 }).toContain('Signed in as')
    await expect.poll(() => dialog.innerText()).toContain(`Synced with ${wsName}`)
  })

  it('signs out and keeps the link (dirty edits keep accumulating)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await dialog.getByRole('button', { name: 'Sign out' }).click()
    await dialog.getByRole('button', { name: 'Sign in' }).waitFor()
    await expect.poll(() => page.getByTestId('sync-chip').getAttribute('data-kind')).toBe('signedOut')
    expect(ctx.problems.filter((p) => !/beacon/.test(p))).toEqual([])
  })
})
