/**
 * Helpers for the cloud e2e specs (need a running slinger-admin server; see cloud.e2e.test.ts for the env vars).
 * The specs play the part of the browser: sign in to the dashboard and approve the pending device code.
 */
import { expect } from 'vitest'
import type { Page } from 'playwright-core'

export const BASE = process.env.SLINGER_E2E_CLOUD_URL
export const EMAIL = process.env.SLINGER_E2E_CLOUD_EMAIL ?? 'admin@example.com'
export const PASSWORD = process.env.SLINGER_E2E_CLOUD_PASSWORD ?? 'dev-only-passphrase-1'

export async function approve(userCode: string): Promise<void> {
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

export async function openCloud(page: Page): Promise<void> {
  if (!(await page.getByRole('dialog', { name: 'Cloud' }).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Cloud', exact: true }).click()
  }
  await page.getByRole('dialog', { name: 'Cloud' }).waitFor()
}

export async function closeDialog(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name }).waitFor({ state: 'detached' })
}

/** Full device-flow sign-in through the UI. Leaves the Cloud dialog open, signed in. */
export async function signInThroughUi(page: Page): Promise<void> {
  await openCloud(page)
  const dialog = page.getByRole('dialog', { name: 'Cloud' })
  if (await dialog.getByText('Signed in as').isVisible().catch(() => false)) return
  await dialog.getByLabel('API base URL').fill(BASE!)
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  const code = await dialog.getByTestId('user-code').innerText()
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  await approve(code)
  await expect.poll(() => dialog.innerText(), { timeout: 30_000, interval: 500 }).toContain('Signed in as')
}
