/**
 * Two-profile sync flow against a REAL slinger-admin server: two app instances (separate user-data
 * directories) act as two devices of one account. Publish on A, link + download on B, secret values stay per
 * device, edits flow both ways, a conflicting edit shows up in B's conflict center and is resolved there.
 * Skipped unless SLINGER_E2E_CLOUD_URL is set (see cloud.e2e.test.ts).
 *
 * Each profile gets its own keychain service (SLINGER_KEYCHAIN_NAMESPACE, set by support/app.ts), so the two
 * devices do not share tokens or secret values even though they run on one machine.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { launch, type Launched } from './support/app'
import { BASE, closeDialog, openCloud, signInThroughUi } from './support/cloud'

describe.skipIf(!BASE)('two-device sync against slinger-admin', () => {
  let tmp: string
  let a: Launched
  let b: Launched
  const wsName = `Sync ${Date.now()}`
  let wsA = ''
  let wsB = ''
  let requestId = ''

  const stub = (l: Launched) =>
    l.app.evaluate(({ shell }) => {
      shell.openExternal = (async () => undefined) as never
    })
  const syncNow = (p: Page, id: string) => p.evaluate((w) => window.slinger.syncNow(w), id)
  const status = (p: Page, id: string) => p.evaluate((w) => window.slinger.getSyncStatus(w), id)

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'slinger-sync-'))
    a = await launch(join(tmp, 'a'))
    b = await launch(join(tmp, 'b'))
    await stub(a)
    await stub(b)
    wsA = await a.page.evaluate(async (name) => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      await window.slinger.renameWorkspace(ws.id, name)
      const col = await window.slinger.createCollection(ws.id, 'Payments')
      const folder = await window.slinger.createFolder({ workspaceId: ws.id, collectionId: col.id, parentFolderId: null, name: 'Auth' })
      const req = await window.slinger.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: folder.id, name: 'Create token', method: 'POST', url: 'https://a.example.test/token', documentJson: '{}' })
      const env = await window.slinger.createEnvironment(ws.id, 'Production')
      await window.slinger.upsertEnvironmentVariable({ environmentId: env.id, key: 'baseUrl', value: 'https://pay.example.test', isSecret: false })
      await window.slinger.upsertEnvironmentVariable({ environmentId: env.id, key: 'apiKey', value: 'A-ONLY-SECRET-1234', isSecret: true })
      return ws.id
    }, wsName)
    requestId = await a.page.evaluate(async (w) => {
      const col = (await window.slinger.listCollections(w)).find((c) => c.name === 'Payments')!
      return (await window.slinger.listRequests(col.id))[0]!.id
    }, wsA)
    await a.page.reload()
    await a.page.getByRole('combobox', { name: 'Workspace' }).waitFor()
  })
  afterAll(async () => {
    await a?.app.close().catch(() => {})
    await b?.app.close().catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
  })

  it('A signs in and publishes', async () => {
    await signInThroughUi(a.page)
    await a.page.getByRole('dialog', { name: 'Cloud' }).getByRole('button', { name: /Publish to cloud/ }).click()
    const publish = a.page.getByRole('dialog', { name: 'Publish to cloud' })
    await publish.getByRole('button', { name: 'Publish' }).click()
    await expect.poll(() => publish.innerText(), { timeout: 60_000 }).toContain('Published.')
    await publish.getByRole('button', { name: 'Done' }).click()
    await closeDialog(a.page, 'Cloud')
    expect(await status(a.page, wsA)).toMatchObject({ linked: true, pendingChanges: 0, openConflicts: 0 })
  })

  it('B signs in and downloads the cloud workspace into a new one', async () => {
    await signInThroughUi(b.page)
    const dialog = b.page.getByRole('dialog', { name: 'Cloud' })
    const row = dialog.getByRole('list', { name: 'Cloud workspaces' }).locator('li', { hasText: wsName })
    await row.getByRole('button', { name: /Link/ }).click()
    const link = b.page.getByRole('dialog', { name: 'Link a cloud workspace' })
    // remote counts from the preview (engine counts what the cloud holds): Payments + its request, and A's environments
    const envsOnA = (await a.page.evaluate(async (w) => window.slinger.listEnvironments(w), wsA)).length
    await expect
      .poll(() => link.getByTestId('link-preview').innerText())
      .toContain(`It already has content: 1 collection, 1 request, ${envsOnA} environment${envsOnA === 1 ? '' : 's'}.`)
    await link.getByRole('button', { name: 'Link and download' }).click()
    await link.waitFor({ state: 'detached' })
    await closeDialog(b.page, 'Cloud')
    wsB = (await b.page.evaluate(() => window.slinger.listSyncStatuses()))[0]!.workspaceId
    await expect.poll(async () => (await status(b.page, wsB)).initialSyncPending, { timeout: 60_000 }).toBe(false)
    await b.page.getByRole('tree', { name: 'Collections' }).getByText('Payments').waitFor()
    const names = await b.page.evaluate(async (w) => {
      const col = (await window.slinger.listCollections(w))[0]!
      return { col: col.name, requests: (await window.slinger.listRequests(col.id)).map((r) => r.name), folders: (await window.slinger.listFolders(col.id)).map((f) => f.name) }
    }, wsB)
    expect(names).toEqual({ col: 'Payments', requests: ['Create token'], folders: ['Auth'] })
  })

  it("the secret's value stays on A: B shows it as not set and gets its own value", async () => {
    const vars = await b.page.evaluate(async (w) => {
      const env = (await window.slinger.listEnvironments(w)).find((e) => e.name === 'Production')!
      return window.slinger.listEnvironmentVariables(env.id)
    }, wsB)
    const secret = vars.find((v) => v.key === 'apiKey')!
    expect(secret.isSecret).toBe(true)
    expect(vars.find((v) => v.key === 'baseUrl')).toMatchObject({ value: 'https://pay.example.test', secretMissing: false })
    expect(secret.secretMissing).toBe(true)
    // UI: open the environment editor on Production and set a value through "Set value".
    await b.page.getByRole('button', { name: /Manage environments|environments/i }).first().click()
    const envDialog = b.page.getByRole('dialog', { name: 'Environments' })
    await envDialog.getByRole('button', { name: 'Production' }).click()
    await expect.poll(() => envDialog.getByTestId('secret-missing').innerText()).toContain('Value not set on this device')
    await envDialog.getByRole('button', { name: 'Set value' }).click()
    await b.page.keyboard.type('B-OWN-SECRET-5678')
    await expect.poll(() => envDialog.getByTestId('secret-missing').count(), { timeout: 10_000 }).toBe(0)
    await envDialog.getByRole('button', { name: 'Close', exact: true }).click()
    const revealed = await b.page.evaluate(async (id) => window.slinger.revealEnvironmentVariable(id), secret.id)
    expect(revealed).toBe('B-OWN-SECRET-5678')
    const onA = await a.page.evaluate(async (w) => {
      const env = (await window.slinger.listEnvironments(w)).find((e) => e.name === 'Production')!
      const v = (await window.slinger.listEnvironmentVariables(env.id)).find((x) => x.key === 'apiKey')!
      return window.slinger.revealEnvironmentVariable(v.id)
    }, wsA)
    expect(onA).toBe('A-ONLY-SECRET-1234')
  })

  it('an edit on B reaches A and A\'s tree updates by itself (applied event)', async () => {
    // Entity ids are shared by both devices, so B renames the very request A published.
    await b.page.evaluate((id) => window.slinger.renameRequest(id, 'Create token (B)'), requestId)
    await syncNow(b.page, wsB)
    await syncNow(a.page, wsA)
    const tree = a.page.getByRole('tree', { name: 'Collections' })
    for (const name of [/Payments/, /Auth/]) {
      const node = tree.getByRole('treeitem', { name })
      if ((await node.getAttribute('aria-expanded')) !== 'true') await node.click()
    }
    await tree.getByText('Create token (B)').waitFor()
    expect(
      await a.page.evaluate(async (id) => {
        const c = (await window.slinger.listCollections((await window.slinger.listWorkspaces())[0]!.id))[0]!
        return (await window.slinger.listRequests(c.id)).find((r) => r.id === id)?.name
      }, requestId),
    ).toBe('Create token (B)')
  })

  it('both edit the same request: B gets a conflict, resolves it in the conflict center, and both converge', async () => {
    // Keep the two devices from syncing on their own while we set the scene.
    await a.page.evaluate((w) => window.slinger.setAutoSync(w, false), wsA)
    await b.page.evaluate((w) => window.slinger.setAutoSync(w, false), wsB)
    const edit = (p: Page, w: string, url: string) =>
      p.evaluate(
        async ({ w, url }) => {
          const c = (await window.slinger.listCollections(w))[0]!
          const r = (await window.slinger.listRequests(c.id))[0]!
          await window.slinger.updateRequest({ requestId: r.id, name: r.name, method: r.method, url, documentJson: r.documentJson, expectedVersion: r.version })
        },
        { w, url },
      )
    await edit(a.page, wsA, 'https://a.example.test/edited')
    await edit(b.page, wsB, 'https://b.example.test/edited')
    // A local edit alone (auto sync off, no cycle) is announced to the renderer: the chip counts it without a reload.
    await expect.poll(() => b.page.getByTestId('sync-chip').innerText(), { timeout: 15_000 }).toContain('1 pending')
    await syncNow(a.page, wsA)
    const st = await syncNow(b.page, wsB)
    expect(st.openConflicts).toBe(1)
    await b.page.reload()
    await b.page.getByRole('combobox', { name: 'Workspace' }).waitFor()
    const chip = b.page.getByTestId('sync-chip')
    await expect.poll(() => chip.getAttribute('data-kind')).toBe('conflicts')
    await chip.click()
    await b.page.getByRole('button', { name: /Review 1 conflict/ }).click()
    const dialog = b.page.getByRole('dialog', { name: 'Sync conflicts' })
    await expect.poll(() => dialog.innerText()).toContain('Changed in both places')
    const card = dialog.getByTestId('conflict-card')
    await expect.poll(() => card.innerText()).toContain('https://b.example.test/edited')
    await expect.poll(() => card.innerText()).toContain('https://a.example.test/edited')
    await card.getByRole('button', { name: 'Use cloud version' }).click()
    await expect.poll(() => dialog.getByTestId('no-conflicts').count(), { timeout: 15_000 }).toBe(1)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const urlB = await b.page.evaluate(async (w) => {
      const c = (await window.slinger.listCollections(w))[0]!
      return (await window.slinger.listRequests(c.id))[0]!.url
    }, wsB)
    expect(urlB).toBe('https://a.example.test/edited')
    expect(await status(b.page, wsB)).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    // No sync traffic in either history.
    for (const [p, w] of [[a.page, wsA], [b.page, wsB]] as const) expect(await p.evaluate((id) => window.slinger.listHistory(id), w)).toEqual([])
  })

  it('unlinking on B keeps the local content and stops syncing', async () => {
    await openCloud(b.page)
    const dialog = b.page.getByRole('dialog', { name: 'Cloud' })
    await dialog.getByRole('button', { name: 'Unlink' }).click()
    await b.page.getByRole('dialog', { name: 'Unlink workspace' }).getByRole('button', { name: 'Unlink' }).click()
    await expect.poll(() => dialog.getByTestId('sync-panel').innerText()).toContain('Local only')
    expect((await status(b.page, wsB)).linked).toBe(false)
    expect((await b.page.evaluate((w) => window.slinger.listCollections(w), wsB)).length).toBe(1)
    expect([...a.problems, ...b.problems].filter((p) => !/beacon/.test(p))).toEqual([])
  })
})
