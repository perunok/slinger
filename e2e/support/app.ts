import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface Launched {
  app: ElectronApplication
  page: Page
  /** console.error / uncaught page errors collected since launch (CSP violations show up here). */
  problems: string[]
}

/**
 * Starts the built app (dist/ + dist-electron/) with an isolated user-data directory.
 * The window is created hidden (SLINGER_HIDE_WINDOW) unless SLINGER_E2E_SHOW=1.
 */
export async function launch(userDataDir: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const args = ['.']
  // Chromium's SUID sandbox is usually unavailable in CI containers / root shells.
  if (process.env.CI || process.getuid?.() === 0) args.push('--no-sandbox')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SLINGER_USER_DATA_DIR: userDataDir,
    ...extraEnv,
  }
  delete env.ELECTRON_RUN_AS_NODE
  if (process.env.SLINGER_E2E_SHOW !== '1') env.SLINGER_HIDE_WINDOW = '1'
  const app = await electron.launch({ args, cwd: ROOT, env })
  const page = await app.firstWindow()
  const problems: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.setDefaultTimeout(8_000)
  await page.waitForSelector('[aria-label="Sidebar"]', { timeout: 30_000 })
  return { app, page, problems }
}

/** Screenshot that also works for a hidden window (page.screenshot needs a visible compositor). */
export async function capture(app: ElectronApplication, file: string): Promise<void> {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const image = await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(base64, 'base64'))
}

/** Replaces native dialogs (which cannot be driven) with fixed answers. */
export async function stubDialogs(app: ElectronApplication, answers: { file?: string | null; directory?: string | null }) {
  await app.evaluate(({ dialog }, a) => {
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { properties?: string[] }
      const wantsDirectory = options.properties?.includes('openDirectory')
      const answer = wantsDirectory ? a.directory : a.file
      return answer ? { canceled: false, filePaths: [answer] } : { canceled: true, filePaths: [] }
    }) as never
  }, answers)
}
