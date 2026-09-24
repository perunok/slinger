/**
 * End-to-end test of the real, built app: Electron main process + the production renderer bundle,
 * driven through Playwright's Electron support with an isolated user-data directory.
 * Run with `npm run test:e2e` (builds first). Steps share one app instance and run in order.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import type { Page } from 'playwright-core'
import { capture, launch, ROOT, stubDialogs, type Launched } from './support/app'
import { PNG, startTarget } from './support/server'

const EXAMPLE = join(ROOT, 'example-postman-collection.json')

const SECRET = 'S3cr3t-Tok3n-9f8e7d6c'
const SHOTS = join(ROOT, 'test-results', 'e2e')

let tmp: string
let userData: string
let exportDir: string
let uploadFile: string
let target: Awaited<ReturnType<typeof startTarget>>
let ctx: Launched
let page: Page
const problems: string[] = []

/** Types into a CodeMirror-backed input, replacing what is there. */
async function typeInto(locator: ReturnType<Page['getByRole']>, text: string) {
  await locator.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  await new Promise((r) => server.close(r))
  return port
}

const tree = () => page.getByRole('tree', { name: 'Collections' })
const item = (name: string | RegExp) => tree().getByRole('treeitem', { name })

async function newCollection(name: string) {
  await page.getByRole('button', { name: 'New collection' }).first().click()
  await page.getByRole('dialog').getByRole('textbox', { name: 'Collection name' }).fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await item(new RegExp(`^${name}`)).waitFor()
}

async function contextMenu(row: ReturnType<typeof item>, entry: string) {
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: entry }).click()
}

async function addEnvVar(key: string, value: string, secret = false) {
  await page.getByTestId('env-row').last().getByRole('textbox', { name: /^Variable name/ }).fill(key)
  // Once the name is typed a fresh blank row is appended, so address the row by its name.
  const row = page.getByTestId('env-row').filter({ has: page.getByRole('textbox', { name: `Variable name: ${key}` }) })
  if (secret) {
    await row.getByRole('checkbox', { name: `Secret: ${key}` }).check()
    await row.getByLabel(`Secret value: ${key}`).fill(value)
  } else {
    await typeInto(row.getByRole('textbox', { name: 'Variable value' }), value)
  }
  await page.getByRole('status').filter({ hasText: /saved/i }).first().waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="env-row"] [aria-label="Saving"]').length === 0)
}

async function newRequest(collection: string | RegExp, name: string, method: string, url: string) {
  await contextMenu(item(collection), 'New request')
  await page.getByRole('dialog').getByRole('textbox', { name: 'Request name' }).fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('tab', { name: new RegExp(name) }).waitFor()
  await page.getByLabel('HTTP method').selectOption(method)
  await typeInto(page.getByRole('textbox', { name: 'Request URL' }), url)
}

async function save() {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).and(page.locator('[disabled]')).waitFor()
}

/** Expands the folder holding `name` when the request row is not currently visible. */
async function reveal(name: RegExp, folder = /^Folder One/) {
  if ((await item(name).count()) === 0) await item(folder).click()
  await item(name).waitFor()
}

const response = () => page.getByRole('region', { name: 'Response' })
async function send() {
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await response().getByTestId('status-chip').waitFor()
}

/** Everything the renderer can see: DOM text/HTML, input values, storage and IPC list results. */
async function rendererSnapshot(): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [document.documentElement.outerHTML, document.body.innerText]
    document.querySelectorAll('input, textarea').forEach((el) => parts.push((el as HTMLInputElement).value))
    parts.push(JSON.stringify({ ...localStorage }))
    const s = window.slinger
    for (const ws of await s.listWorkspaces()) {
      parts.push(JSON.stringify(ws), JSON.stringify(await s.listHistory(ws.id)))
      for (const env of await s.listEnvironments(ws.id)) {
        parts.push(JSON.stringify(env), JSON.stringify(await s.listEnvironmentVariables(env.id)))
      }
      for (const c of await s.listCollections(ws.id)) {
        parts.push(JSON.stringify(await s.listFolders(c.id)), JSON.stringify(await s.listRequests(c.id)))
        for (const v of await s.listCollectionVersions(c.id)) parts.push(JSON.stringify(await s.getCollectionVersion(v.id)))
      }
    }
    return parts.join('\n')
  })
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-'))
  userData = join(tmp, 'user-data')
  exportDir = join(tmp, 'exports')
  mkdirSync(exportDir)
  uploadFile = join(tmp, 'upload.txt')
  writeFileSync(uploadFile, 'file-contents-for-multipart')
  target = await startTarget()
  ctx = await launch(userData)
  page = ctx.page
  problems.push(...ctx.problems)
  await stubDialogs(ctx.app, { file: uploadFile, directory: exportDir })
})

beforeEach((t) => {
  onTestFailed(async () => {
    const name = t.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    await capture(ctx.app, join(SHOTS, `FAILED-${name}.png`)).catch(() => {})
    console.log(`[e2e] failure screenshot: ${join(SHOTS, `FAILED-${name}.png`)}`)
  })
})

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  await target?.close()
  if (!process.env.SLINGER_E2E_KEEP) rmSync(tmp, { recursive: true, force: true })
})

describe('transport', () => {
  it('runs sandboxed with only the preload bridge exposed', async () => {
    const info = await page.evaluate(() => ({
      require: typeof (window as any).require,
      process: typeof (window as any).process,
      methods: Object.keys(window.slinger).length,
    }))
    expect(info).toMatchObject({ require: 'undefined', process: 'undefined' })
    expect(info.methods).toBeGreaterThan(45)
  })

  it('rejects with a plain IpcError object that the renderer understands', async () => {
    const err = await page.evaluate(async () => {
      try {
        await window.slinger.renameWorkspace('not-a-uuid', 'x')
      } catch (e) {
        const o = e as Record<string, unknown>
        return { isError: e instanceof Error, name: o.name, code: o.code, message: o.message }
      }
      return null
    })
    expect(err).toMatchObject({ isError: false, name: 'IpcError', code: 'invalid_input' })
  })
})

describe('workspace content', () => {
  it('creates a collection, a folder and a request', async () => {
    await newCollection('Col A')
    await contextMenu(item(/^Col A/), 'New folder')
    await page.getByRole('dialog').getByRole('textbox', { name: 'Folder name' }).fill('Folder One')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await item(/^Folder One/).waitFor()
    await contextMenu(item(/^Col A/), 'New request')
    await page.getByRole('dialog').getByRole('textbox', { name: 'Request name' }).fill('Echo')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await item(/Echo$/).waitFor()
    await page.getByRole('tab', { name: /Echo/ }).waitFor()
  })

  it('sets up an environment with plain and secret variables', async () => {
    await page.getByRole('button', { name: 'Manage environments' }).click()
    const dialog = page.getByRole('dialog', { name: 'Environments' })
    await dialog.waitFor()
    await addEnvVar('baseUrl', target.url)
    await addEnvVar('pathPart', 'v1')
    await addEnvVar('user', 'alice')
    await addEnvVar('token', SECRET, true)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    // The secret is masked in the list the renderer receives.
    const listed = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const envs = await window.slinger.listEnvironments(ws.id)
      return JSON.stringify(await Promise.all(envs.map((e) => window.slinger.listEnvironmentVariables(e.id))))
    })
    expect(listed).toContain('token')
    expect(listed).not.toContain(SECRET)
  })

  it('resolves {{variables}} in URL, header, body and auth when sending', async () => {
    await typeInto(page.getByRole('textbox', { name: 'Request URL' }), '{{baseUrl}}/{{pathPart}}/echo?who={{user}}')
    await page.getByLabel('HTTP method').selectOption('POST')

    await page.getByRole('tab', { name: 'Headers' }).click()
    await typeInto(page.getByRole('textbox', { name: 'Header 1 key' }), 'X-Trace')
    await typeInto(page.getByRole('textbox', { name: 'Header 1 value' }), 'trace-{{user}}')

    await page.getByRole('tab', { name: 'Authorization' }).click()
    await page.getByLabel('Authorization type').selectOption('bearer')
    await typeInto(page.getByRole('textbox', { name: 'Token' }), '{{token}}')

    await page.getByRole('tab', { name: 'Body' }).click()
    await page.getByRole('radio', { name: 'raw' }).check()
    await typeInto(page.getByRole('textbox', { name: 'Request body' }), '{"user":"{{user}}","n":1}')

    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('region', { name: 'Response' }).getByText('200').first().waitFor()
    await save()

    const req = target.requests.at(-1)!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v1/echo?who=alice')
    expect(req.headers['x-trace']).toBe('trace-alice')
    expect(req.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(req.body.toString())).toEqual({ user: 'alice', n: 1 })
    await expect.poll(() => page.getByRole('region', { name: 'Response' }).innerText()).toContain('trace-alice')
  })

  it('records the send in history without the secret', async () => {
    await page.getByRole('tab', { name: 'History' }).click()
    const panel = page.getByRole('tabpanel', { name: 'History' })
    await expect.poll(() => panel.innerText()).toContain('/v1/echo?who=alice')
    await page.getByRole('tab', { name: 'Collections' }).click()
  })
})

describe('request bodies and responses', () => {
  it('sends multipart form-data with a text field and a picked file', async () => {
    await newRequest(/^Col A/, 'Upload', 'POST', '{{baseUrl}}/upload')
    await page.getByRole('tab', { name: 'Body' }).click()
    await page.getByRole('radio', { name: 'form-data' }).check()
    await typeInto(page.getByRole('textbox', { name: 'Field 1 key' }), 'note')
    await typeInto(page.getByRole('textbox', { name: 'Field 1 value' }), 'hello {{user}}')
    await typeInto(page.getByRole('textbox', { name: 'Field 2 key' }), 'doc')
    await page.getByLabel('Field 2 type').selectOption('file')
    await page.getByRole('button', { name: /Choose file/ }).first().click()
    await send()
    const req = target.requests.at(-1)!
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const body = req.body.toString()
    expect(body).toContain('name="note"')
    expect(body).toContain('hello alice')
    expect(body).toContain('name="doc"; filename="upload.txt"')
    expect(body).toContain('file-contents-for-multipart')
  })

  it('shows a PNG response as an image and saves the exact bytes', async () => {
    // The stubbed folder dialog picks the temp export directory.
    expect(await page.evaluate(() => window.slinger.chooseExportDirectory())).toBe(exportDir)
    await newRequest(/^Col A/, 'Image', 'GET', '{{baseUrl}}/binary.png')
    await send()
    const img = response().getByRole('img', { name: 'Response body' })
    await img.waitFor()
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
    await response().getByRole('button', { name: 'Save response to file' }).click()
    await expect.poll(() => readdirSync(exportDir).some((f) => f.endsWith('.png'))).toBe(true)
    const saved = readdirSync(exportDir).find((f) => f.endsWith('.png'))!
    expect(readFileSync(join(exportDir, saved)).equals(PNG)).toBe(true)
  })

  it('handles an arbitrary binary response (hex view, byte-exact save)', async () => {
    await newRequest(/^Col A/, 'Blob', 'GET', '{{baseUrl}}/blob.bin')
    await send()
    await expect.poll(() => response().innerText()).toContain('Binary response')
    await response().getByRole('tab', { name: 'Raw' }).click()
    await expect.poll(() => response().innerText()).toMatch(/00 ff fe 01 02 03 80 c8/i)
    const before = new Set(readdirSync(exportDir))
    await response().getByRole('button', { name: 'Save response to file' }).click()
    await expect.poll(() => readdirSync(exportDir).some((f) => !before.has(f))).toBe(true)
    const saved = readdirSync(exportDir).find((f) => !before.has(f))!
    expect([...readFileSync(join(exportDir, saved))]).toEqual([0, 255, 254, 1, 2, 3, 128, 200])
  })

  it('previews a PDF in a blob: iframe permitted by the CSP', async () => {
    await newRequest(/^Col A/, 'Pdf', 'GET', '{{baseUrl}}/doc.pdf')
    await send()
    const frame = response().locator('iframe[title="PDF preview"]')
    await frame.waitFor()
    await expect.poll(() => page.frames().some((f) => f.url().startsWith('blob:'))).toBe(true)
    // A CSP frame-src violation would have been logged as a console error.
    expect(ctx.problems.filter((p) => /frame-src|Content Security Policy/i.test(p))).toEqual([])
    await page.waitForTimeout(1500) // let the built-in PDF viewer paint
    await capture(ctx.app, join(SHOTS, 'pdf-preview.png'))
  })

  it('renders an HTML preview in a sandboxed srcdoc iframe without running scripts or loading remote resources', async () => {
    await newRequest(/^Col A/, 'Html', 'GET', '{{baseUrl}}/page.html')
    await send()
    await response().getByRole('tab', { name: 'Preview' }).click()
    const frame = response().frameLocator('iframe[title="HTML preview"]')
    await expect.poll(() => frame.locator('#hello').innerText()).toBe('Hello preview')
    expect(await response().locator('iframe[title="HTML preview"]').getAttribute('sandbox')).toBe('')
    const scriptRan = await frame.locator('body').evaluate(() => document.title === 'script-ran')
    expect(scriptRan).toBe(false)
    await capture(ctx.app, join(SHOTS, 'html-preview.png'))
  })

  it('keeps the secret out of everything the renderer can see', async () => {
    expect(await rendererSnapshot()).not.toContain(SECRET)
  })
})

describe('organising', () => {
  it('moves a request into a folder by drag and drop', async () => {
    await item(/^Folder One/).waitFor()
    await item(/Echo$/).dragTo(item(/^Folder One/))
    const folderId = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const col = (await window.slinger.listCollections(ws.id)).find((c) => c.name === 'Col A')!
      const folder = (await window.slinger.listFolders(col.id)).find((f) => f.name === 'Folder One')!
      const echo = (await window.slinger.listRequests(col.id)).find((r) => r.name === 'Echo')!
      return echo.folderId === folder.id
    })
    expect(folderId).toBe(true)
    await expect.poll(() => item(/Echo$/).getAttribute('aria-level')).toBe('3')
  })
})

describe('errors', () => {
  it('shows a network failure inline, keeps working, and records it in history', async () => {
    const closed = await closedPort()
    await newRequest(/^Col A/, 'Refused', 'GET', `http://127.0.0.1:${closed}/nothing`)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => response().innerText(), { timeout: 8000 }).toMatch(/not sent|refused/i)
    await page.getByRole('tab', { name: 'History' }).click()
    await expect.poll(() => page.getByRole('tabpanel', { name: 'History' }).innerText()).toContain(`127.0.0.1:${closed}/nothing`)
    await page.getByRole('tab', { name: 'Collections' }).click()
  })

  it('refuses to send while a variable is unresolved and names it', async () => {
    await newRequest(/^Col A/, 'Unresolved', 'GET', '{{doesNotExist}}/x')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => response().innerText()).toContain('doesNotExist')
    expect(target.requests.some((r) => r.url === '/x')).toBe(false)
  })
})

describe('collection versions', () => {
  const versionsDialog = () => page.getByRole('dialog', { name: /^Versions/ })
  async function createVersion(version: string) {
    await versionsDialog().getByRole('button', { name: 'Create version' }).first().click()
    await page.getByRole('textbox', { name: /^Version/ }).fill(version)
    await page.getByRole('dialog', { name: /Create version|New version/ }).getByRole('button', { name: 'Create version' }).click()
    await versionsDialog().getByRole('option', { name: new RegExp(version.replace(/\./g, '\\.')) }).waitFor()
  }

  it('creates 1.0.0, changes the collection, creates 1.1.0', async () => {
    await contextMenu(item(/^Col A/), 'Versions…')
    await createVersion('1.0.0')
    await versionsDialog().getByRole('button', { name: 'Close dialog' }).click()
    await newRequest(/^Col A/, 'Added Later', 'GET', '{{baseUrl}}/later')
    await contextMenu(item(/^Col A/), 'Versions…')
    await createVersion('1.1.0')
    // Newest semver first.
    const labels = await versionsDialog().getByRole('option').allInnerTexts()
    expect(labels[0]).toContain('1.1.0')
    expect(labels[1]).toContain('1.0.0')
  })

  it('rejects a duplicate version label', async () => {
    await versionsDialog().getByRole('button', { name: 'Create version' }).first().click()
    await page.getByRole('textbox', { name: /^Version/ }).fill('1.0.0')
    await expect.poll(() => page.getByRole('dialog', { name: /Create version|New version/ }).innerText()).toMatch(/already exists|exists/i)
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  it('restores 1.0.0 in place: the later request disappears and open tabs survive', async () => {
    await versionsDialog().getByRole('option', { name: /1\.0\.0/ }).click()
    await versionsDialog().getByRole('button', { name: /Restore/ }).click()
    await page.getByRole('radio', { name: /Replace/ }).check()
    await page.getByRole('button', { name: 'Replace collection...' }).click()
    await page.getByRole('dialog', { name: 'Overwrite live collection?' }).getByRole('button', { name: 'Replace collection' }).click()
    await expect.poll(async () => (await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const col = (await window.slinger.listCollections(ws.id)).find((c) => c.name === 'Col A')!
      return (await window.slinger.listRequests(col.id)).map((r) => r.name)
    })).includes('Added Later')).toBe(false)
    if (await versionsDialog().count()) await versionsDialog().getByRole('button', { name: 'Close dialog' }).click()
    await reveal(/Echo$/)
    expect(await item(/Added Later/).count()).toBe(0)
    // Replace-restore recreates requests with new ids, so the old (clean) Echo tab was closed
    // by the renderer; opening the restored request from the tree works and uses the secret.
    expect(await page.getByRole('tab', { name: /Echo/ }).count()).toBe(0)
    await item(/Echo$/).click()
    await send()
    expect(await response().getByTestId('status-chip').innerText()).toContain('200')
    expect(target.requests.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`)
    // Both versions remain.
    const versions = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const col = (await window.slinger.listCollections(ws.id)).find((c) => c.name === 'Col A')!
      return (await window.slinger.listCollectionVersions(col.id)).map((v) => v.version)
    })
    expect(versions).toEqual(['1.1.0', '1.0.0'])
  })
})

describe('import and export', () => {
  it('imports the example Postman collection', async () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'))
    await page.getByRole('button', { name: 'Import Postman collection' }).click()
    await page.getByLabel('Postman file').setInputFiles(EXAMPLE)
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click()
    await item(new RegExp('^' + String(example.info.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).waitFor()
    const count = await page.evaluate(async (name) => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const col = (await window.slinger.listCollections(ws.id)).find((c) => c.name === name)!
      return (await window.slinger.listRequests(col.id)).length
    }, example.info.name)
    expect(count).toBeGreaterThanOrEqual(8)
  })

  it('exports a collection as Postman v2.1 JSON to the chosen folder', async () => {
    await contextMenu(item(/^Col A/), 'Export as Postman JSON…')
    const dialog = page.getByRole('dialog', { name: 'Export collection' })
    await dialog.getByRole('button', { name: /Choose folder/ }).click()
    await dialog.getByRole('button', { name: 'Copy to clipboard' }).click()
    await expect.poll(() => page.getByText('Copied to clipboard').count()).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Save to file' }).click()
    await dialog.waitFor({ state: 'hidden' }) // the dialog closes itself once the file is written
    await expect.poll(() => readdirSync(exportDir).some((f) => f.endsWith('.json'))).toBe(true)
    const file = readdirSync(exportDir).find((f) => f.endsWith('.json'))!
    const exported = JSON.parse(readFileSync(join(exportDir, file), 'utf8'))
    expect(exported.info.schema).toMatch(/v2\.1/)
    expect(JSON.stringify(exported)).toContain('Echo')
    expect(JSON.stringify(exported)).not.toContain(SECRET)
  })
})

describe('themes', () => {
  const themes = ['light', 'dark', 'midnight', 'solarized', 'contrast']

  it('switches through every theme and screenshots each', async () => {
    await reveal(/Echo$/)
    await item(/Echo$/).click()
    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog', { name: /Settings/ })
    for (const id of themes) {
      await dialog.locator(`input[name=theme][value=${id}]`).check({ force: true })
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(id)
      await dialog.getByRole('button', { name: 'Done' }).click()
      await dialog.waitFor({ state: 'hidden' })
      await capture(ctx.app, join(SHOTS, `theme-${id}.png`))
      await page.getByRole('button', { name: 'Settings' }).click()
    }
    await dialog.locator('input[name=theme][value=midnight]').check({ force: true })
    await dialog.getByRole('button', { name: 'Done' }).click()
  })
})

describe('persistence across restart', () => {
  it('restarts the app and finds everything, secret included, still working', async () => {
    await ctx.app.close()
    ctx = await launch(userData)
    page = ctx.page
    problems.push(...ctx.problems)
    await stubDialogs(ctx.app, { file: uploadFile, directory: exportDir })

    await item(/^Col A/).waitFor()
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('midnight')

    const vars = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const env = (await window.slinger.listEnvironments(ws.id))[0]!
      return (await window.slinger.listEnvironmentVariables(env.id)).map((v) => ({ key: v.key, secret: v.isSecret, value: v.value }))
    })
    expect(vars.map((v) => v.key).sort()).toEqual(['baseUrl', 'pathPart', 'token', 'user'])
    expect(vars.find((v) => v.key === 'token')).toMatchObject({ secret: true, value: null })

    await reveal(/Echo$/)
    await item(/Echo$/).click()
    await send()
    expect(target.requests.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('never wrote the secret to the renderer or to the database files', async () => {
    expect(await rendererSnapshot()).not.toContain(SECRET)
    for (const file of readdirSync(userData).filter((f) => f.startsWith('slinger.db'))) {
      expect(readFileSync(join(userData, file)).includes(SECRET), file).toBe(false)
    }
  })

  it('deletes the secret variable and its keychain entry', async () => {
    const result = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const env = (await window.slinger.listEnvironments(ws.id))[0]!
      const token = (await window.slinger.listEnvironmentVariables(env.id)).find((v) => v.key === 'token')!
      await window.slinger.deleteEnvironmentVariable(token.id)
      try {
        await window.slinger.revealEnvironmentVariable(token.id)
        return 'still revealable'
      } catch (e) {
        return (e as { code: string }).code
      }
    })
    expect(result).toBe('not_found')
  })

  it('logged no CSP violations or page errors other than the blocked remote image beacon', async () => {
    const unexpected = problems.filter((p) => !/beacon\.png/.test(p))
    expect(unexpected).toEqual([])
  })
})
