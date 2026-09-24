/**
 * Cloud panel against a REAL slinger-admin server (device-flow sign-in, publish, session restore,
 * sign-out). Skipped unless SLINGER_E2E_CLOUD_URL is set, e.g.
 *
 *   SLINGER_E2E_CLOUD_URL=http://127.0.0.1:18080 \
 *   SLINGER_E2E_CLOUD_EMAIL=admin@example.com SLINGER_E2E_CLOUD_PASSWORD=dev-only-passphrase-1 \
 *   npm run test:e2e:run -- e2e/cloud
 *
 * See slinger-admin/server/README.md for starting the server (Postgres in docker).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { launch, type Launched } from './support/app'

const BASE = process.env.SLINGER_E2E_CLOUD_URL
const EMAIL = process.env.SLINGER_E2E_CLOUD_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.SLINGER_E2E_CLOUD_PASSWORD ?? 'dev-only-passphrase-1'

/** Plays the part of the browser: signs in to the dashboard and approves the pending user code. */
async function approve(userCode: string) {
  const login = await fetch(`${BASE}/v1/auth/browser/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  expect(login.status).toBe(200)
  const { csrf_token } = (await login.json()) as { csrf_token: string }
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const res = await fetch(`${BASE}/v1/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf_token },
    body: JSON.stringify({ user_code: userCode }),
  })
  expect(res.status).toBe(200)
}

describe.skipIf(!BASE)('cloud panel against slinger-admin', () => {
  let tmp: string
  let ctx: Launched
  let page: Page
  const wsName = `E2E ${Date.now()}`

  const openCloud = async () => {
    await page.getByRole('button', { name: 'Cloud' }).click()
    await page.getByRole('dialog', { name: 'Cloud' }).waitFor()
  }

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
    }, wsName)
    await page.reload()
    await page.getByRole('combobox', { name: 'Workspace' }).waitFor()
  })
  afterAll(async () => {
    await ctx?.app.close().catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
  })

  it('signs in through the device flow', async () => {
    await openCloud()
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await dialog.getByLabel('API base URL').fill(BASE!)
    await dialog.getByRole('button', { name: 'Sign in' }).click()
    const code = await dialog.getByTestId('user-code').innerText()
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    await approve(code)
    await expect.poll(() => dialog.innerText(), { timeout: 30_000, interval: 500 }).toContain('Signed in as')
  })

  it('publishes the local workspace and links it', async () => {
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await dialog.getByRole('button', { name: 'Publish to cloud' }).click()
    await expect.poll(() => dialog.innerText()).toContain(`Linked to ${wsName}`)
    await expect.poll(() => dialog.getByRole('list', { name: 'Cloud workspaces' }).innerText()).toContain(wsName)
  })

  it('restores the session after a restart (tokens come from the OS keychain)', async () => {
    await ctx.app.close()
    ctx = await launch(join(tmp, 'ud'))
    page = ctx.page
    await openCloud()
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await expect.poll(() => dialog.innerText(), { timeout: 15_000 }).toContain('Signed in as')
    await expect.poll(() => dialog.innerText()).toContain(`Linked to ${wsName}`)
  })

  it('signs out and clears the stored session', async () => {
    const dialog = page.getByRole('dialog', { name: 'Cloud' })
    await dialog.getByRole('button', { name: 'Sign out' }).click()
    await dialog.getByRole('button', { name: 'Sign in' }).waitFor()
    expect(ctx.problems.filter((p) => !/beacon/.test(p))).toEqual([])
  })
})
