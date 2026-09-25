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
    await save() // kept for the "file not granted after restart" check below
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

  it('never lets the renderer read a file the user did not pick, and cloudFetch leaves no history', async () => {
    const other = join(tmp, 'not-picked.txt')
    writeFileSync(other, 'private')
    const outcome = await page.evaluate(
      async ({ file, url }) => {
        const s = window.slinger
        const ws = (await s.listWorkspaces())[0]!
        const historyBefore = (await s.listHistory(ws.id)).length
        let code = ''
        try {
          await s.executeHttpRequest({
            method: 'PUT', url: `${url}/leak`, headers: [], auth: { kind: 'none' },
            body: { mode: 'binary', binaryFilePath: file }, workspaceId: ws.id,
          })
        } catch (e) {
          code = (e as { code?: string }).code ?? ''
        }
        const historyAfterFailedFile = (await s.listHistory(ws.id)).length
        const res = await s.cloudFetch({ method: 'GET', url: `${url}/cloud-ping`, headers: [] })
        return { code, status: res.status, historyBefore, historyAfterFailedFile, historyAfterCloud: (await s.listHistory(ws.id)).length }
      },
      { file: other, url: target.url },
    )
    expect(outcome.code).toBe('invalid_input')
    expect(outcome.status).toBe(200)
    expect(target.requests.some((r) => r.url === '/leak')).toBe(false)
    expect(target.requests.some((r) => r.url === '/cloud-ping')).toBe(true)
    expect(outcome.historyAfterCloud).toBe(outcome.historyAfterFailedFile)
  })

  it('refuses to send while a variable is unresolved and names it', async () => {
    await newRequest(/^Col A/, 'Unresolved', 'GET', '{{doesNotExist}}/x')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => response().innerText()).toContain('doesNotExist')
    expect(target.requests.some((r) => r.url === '/x')).toBe(false)
  })
})

describe('collection runner', () => {
  it('runs a collection and reports every request', async () => {
    await page.evaluate(async () => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]!
      const col = await s.createCollection(ws.id, 'Run C')
      for (const n of ['one', 'two']) {
        await s.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: null, name: `run-${n}`, method: 'GET', url: `{{baseUrl}}/runner/${n}`, documentJson: JSON.stringify({ headers: [], body: null }) })
      }
    })
    await page.reload()
    await item(/^Run C/).waitFor()
    const before = target.requests.length
    await contextMenu(item(/^Run C/), 'Run collection…')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Run/ }).first().click()
    await expect.poll(() => dialog.getByRole('list', { name: 'Run results' }).innerText()).toMatch(/run-one[\s\S]*run-two/)
    await expect.poll(() => target.requests.slice(before).map((r) => r.url)).toEqual(['/runner/one', '/runner/two'])
    await expect.poll(() => dialog.getByRole('button', { name: 'Run again' }).count()).toBe(1)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  })
})

describe('collection runner: 3xx', () => {
  it('fails an unfollowed 3xx by default, passes a followed redirect, and honours "Treat 3xx as pass"', async () => {
    await page.evaluate(async () => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]!
      const col = await s.createCollection(ws.id, 'Redirect C')
      for (const [name, path] of [['redirect-followed', 'ok'], ['redirect-dead-end', 'nowhere']] as const) {
        await s.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: null, name, method: 'GET', url: `{{baseUrl}}/redirect/${path}`, documentJson: JSON.stringify({ headers: [], body: null }) })
      }
    })
    await page.reload()
    await item(/^Redirect C/).waitFor()
    await contextMenu(item(/^Redirect C/), 'Run collection…')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Run 2/ }).click()
    await expect.poll(() => dialog.getByTestId('summary').innerText()).toContain('1 passed')
    const rows = dialog.getByRole('list', { name: 'Run results' }).getByRole('listitem')
    // order is tree order; find rows by name to stay independent of it
    const followed = rows.filter({ hasText: 'redirect-followed' })
    const dead = rows.filter({ hasText: 'redirect-dead-end' })
    expect(await followed.getAttribute('data-status')).toBe('passed')
    expect(await followed.innerText()).toContain('200') // status is shown per row
    expect(await dead.getAttribute('data-status')).toBe('failed')
    expect(await dead.innerText()).toContain('302')
    await dialog.getByRole('button', { name: 'Configure' }).click()
    await dialog.getByRole('checkbox', { name: 'Treat 3xx as pass' }).check()
    await dialog.getByRole('button', { name: /^Run 2/ }).click()
    await expect.poll(() => dialog.getByTestId('summary').innerText()).toContain('2 passed')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  })
})

describe('scripts', () => {
  const LOGIN_TEST = [
    'const token = pm.response.json().token',
    "pm.environment.set('authToken', token)",
    "pm.test('got a token', () => pm.expect(token).to.be.a('string'))",
    "console.log('saved token', token)",
  ].join('\n')

  it('sets up a collection with a collection-level test script and a request with pre-request and test scripts', async () => {
    await page.evaluate(async () => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]!
      const col = await s.createCollection(ws.id, 'Script C')
      await s.setCollectionScripts(col.id, JSON.stringify([
        { listen: 'test', script: { type: 'text/javascript', exec: ["pm.test('collection: 2xx', () => pm.response.to.be.success)"] } },
      ]))
      await s.createRequest({ workspaceId: ws.id, collectionId: col.id, folderId: null, name: 'login', method: 'POST', url: '{{baseUrl}}/login', documentJson: JSON.stringify({ headers: [], body: null }) })
      await s.createRequest({
        workspaceId: ws.id, collectionId: col.id, folderId: null, name: 'me', method: 'GET', url: '{{baseUrl}}/me',
        documentJson: JSON.stringify({
          headers: [{ key: 'Authorization', value: 'Bearer {{authToken}}', type: 'text' }],
          body: null,
          scripts: [
            { listen: 'prerequest', script: { type: 'text/javascript', exec: ["pm.request.headers.upsert({ key: 'X-From-Script', value: 'pre-' + pm.info.requestName })"] } },
            { listen: 'test', script: { type: 'text/javascript', exec: [
              "pm.test('authorized', () => pm.response.to.have.status(200))",
              "pm.test('deliberately failing', () => pm.expect(pm.response.json().user).to.equal('bob'))",
            ] } },
          ],
        }),
      })
    })
    await page.reload()
    await item(/^Script C/).waitFor()
  })

  it('writes a login test script in the Scripts tab that stores the token in the environment', async () => {
    await reveal(/login$/, /^Script C/)
    await item(/login$/).click()
    await page.getByRole('tab', { name: /^Scripts/ }).click()
    await page.getByRole('tablist', { name: 'Script type' }).getByRole('tab', { name: /^Tests/ }).click()
    await typeInto(page.getByRole('textbox', { name: 'Test script' }), LOGIN_TEST)
    await save()
    const stored = await page.evaluate(async () => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]!
      const col = (await s.listCollections(ws.id)).find((c) => c.name === 'Script C')!
      return JSON.parse((await s.listRequests(col.id)).find((r) => r.name === 'login')!.documentJson).scripts
    })
    expect(stored).toEqual([{ listen: 'test', script: { type: 'text/javascript', exec: LOGIN_TEST.split('\n') } }])

    await send()
    const badge = response().getByTestId('resp-tests-badge')
    await expect.poll(() => badge.innerText()).toBe('2/2')
    await response().getByRole('tab', { name: /^Console/ }).click()
    await expect.poll(() => response().getByRole('list', { name: 'Console output' }).innerText()).toContain(`saved token ${target.issuedTokens.at(-1)}`)
    const vars = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const env = (await window.slinger.listEnvironments(ws.id))[0]!
      return (await window.slinger.listEnvironmentVariables(env.id)).map((v) => [v.key, v.value])
    })
    expect(vars).toContainEqual(['authToken', target.issuedTokens.at(-1)])
  })

  it('a second request uses {{authToken}}; the server accepts it and a failing assertion shows in the Tests tab', async () => {
    const before = target.requests.length
    await item(/me$/).click()
    await send()
    const req = target.requests.slice(before).find((r) => r.url === '/me')!
    expect(req.headers.authorization).toBe(`Bearer ${target.issuedTokens.at(-1)}`)
    expect(req.headers['x-from-script']).toBe('pre-me') // added by the pre-request script
    await expect.poll(() => response().getByTestId('status-chip').innerText()).toContain('200')
    await expect.poll(() => response().getByTestId('resp-tests-badge').innerText()).toBe('2/3')
    await response().getByRole('tab', { name: /^Tests/ }).click()
    const results = response().getByRole('list', { name: 'Test results' })
    await expect.poll(() => response().getByTestId('tests-summary').innerText()).toMatch(/2 passed, 1 failed/)
    const failed = results.getByRole('listitem').filter({ hasText: 'deliberately failing' })
    expect(await failed.getAttribute('data-status')).toBe('failed')
    expect(await failed.innerText()).toContain("AssertionError: expected 'alice' to equal 'bob'")
    // The pre-request header went out but was never saved into the request.
    const doc = await page.evaluate(async () => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]!
      const col = (await s.listCollections(ws.id)).find((c) => c.name === 'Script C')!
      return (await s.listRequests(col.id)).find((r) => r.name === 'me')!.documentJson
    })
    expect(doc).not.toContain('pre-me')
  })

  it('the collection runner runs the scripts, passes the new token on and counts the tests', async () => {
    const tokensBefore = target.issuedTokens.length
    await contextMenu(item(/^Script C/), 'Run collection…')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Run 2/ }).click()
    await expect.poll(() => dialog.getByTestId('summary').innerText()).toMatch(/1 passed, 1 failed/)
    expect(await dialog.getByTestId('summary-tests').innerText()).toMatch(/Tests: 4 passed, 1 failed/)
    expect(target.issuedTokens.length).toBe(tokensBefore + 1)
    const me = target.requests.filter((r) => r.url === '/me').at(-1)!
    expect(me.headers.authorization).toBe(`Bearer ${target.issuedTokens.at(-1)}`) // the token from THIS run's login
    const rows = dialog.getByRole('list', { name: 'Run results' }).getByRole('listitem')
    expect(await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status))).toEqual(['passed', 'failed'])
    expect(await rows.nth(1).innerText()).toContain('1 of 3 tests failed')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
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

  it('restores 1.0.0 in place: the folder stays expanded and the replaced Echo tab can be reopened', async () => {
    // Open Echo (clean) before restoring, so there is a tab the restore has to replace.
    await versionsDialog().getByRole('button', { name: 'Close dialog' }).click()
    await item(/Echo$/).click()
    await page.getByRole('tab', { name: /Echo/ }).waitFor()
    await contextMenu(item(/^Col A/), 'Versions…')
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
    // The folder keeps its expanded state (ids differ, but the folder is matched by name/path):
    // the restored request is visible without clicking the folder open again.
    await item(/Echo$/).waitFor()
    expect(await item(/Added Later/).count()).toBe(0)
    // Replace-restore recreates requests with new ids, so the old (clean) Echo tab was closed;
    // the app offers to reopen the restored request of the same name.
    expect(await page.getByRole('tab', { name: /Echo/ }).count()).toBe(0)
    await page.getByRole('button', { name: 'Reopen restored request' }).click()
    await page.getByRole('tab', { name: /Echo/ }).waitFor()
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

  it('lists the imported saved examples under their requests and opens one', async () => {
    const col = item(/^thub-collection/)
    if ((await col.getAttribute('aria-expanded')) !== 'true') await col.click()
    const request = item(/Create Charge Detail$/)
    expect(await request.getAttribute('aria-expanded')).toBe('false')
    await request.getByTestId('examples-toggle').click() // the chevron expands without opening the request
    await item(/^201 success$/).waitFor()
    await item(/^400 failure$/).waitFor()
    expect(await page.getByRole('tab', { name: /Create Charge Detail/ }).count()).toBe(0)
    await item(/^201 success$/).click()
    const view = page.getByTestId('example-view')
    await view.waitFor()
    const saved = page.getByRole('region', { name: 'Example response' })
    expect(await saved.getByTestId('status-chip').innerText()).toBe('201 Created')
    await expect.poll(() => saved.innerText()).toContain('"SUCCESS"')
    expect(await page.getByRole('textbox', { name: 'Request URL' }).innerText()).toContain('/api/v1/transferhub/charge-details')
  })

  it('edits and saves an example into its request; the other example stays byte-identical', async () => {
    await page.getByRole('textbox', { name: 'Example name' }).fill('success edited')
    await page.getByRole('spinbutton', { name: 'Status code' }).fill('202')
    await expect.poll(() => page.getByRole('textbox', { name: 'Status text' }).inputValue()).toBe('Accepted')
    await save()
    await item(/^202 success edited$/).waitFor()
    const original = JSON.parse(readFileSync(EXAMPLE, 'utf8')).item[0].response
    const stored = await page.evaluate(async () => {
      const ws = (await window.slinger.listWorkspaces())[0]!
      const col = (await window.slinger.listCollections(ws.id)).find((c) => c.name === 'thub-collection')!
      const r = (await window.slinger.listRequests(col.id)).find((x) => x.name === 'Create Charge Detail')!
      return JSON.parse(r.documentJson).responses
    })
    expect(JSON.stringify(stored[0])).toBe(JSON.stringify({ ...original[0], name: 'success edited', status: 'Accepted', code: 202 }))
    expect(JSON.stringify(stored[1])).toBe(JSON.stringify(original[1]))
  })

  it('"Try" sends the example request from a new tab and leaves the example alone', async () => {
    const before = target.requests.length
    await page.getByRole('button', { name: 'Try', exact: true }).click()
    await response().getByTestId('status-chip').waitFor()
    expect(target.requests.slice(before).map((r) => r.url)).toEqual(['/api/v1/transferhub/charge-details'])
    expect(await page.getByTestId('example-view').count()).toBe(0) // a request tab is active now
    await page.getByRole('tab', { name: /success edited/ }).waitFor()
  })

  it('saves a live binary response as an example (base64) that shows as an image', async () => {
    // "Image" was restored from version 1.0.0 without its (never saved) URL: set and save it first,
    // since Save as example needs a stored request. Its response carries no secret (no auth).
    await item(/Image$/).click()
    await typeInto(page.getByRole('textbox', { name: 'Request URL' }), '{{baseUrl}}/binary.png')
    await save()
    await send()
    await response().getByRole('button', { name: 'Save as example' }).click()
    const dialog = page.getByRole('dialog', { name: 'Save as example' })
    expect(await dialog.getByRole('textbox', { name: 'Example name' }).inputValue()).toBe('200 OK')
    await dialog.getByRole('textbox', { name: 'Example name' }).fill('png ok')
    await dialog.getByRole('button', { name: 'Save example' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await item(/^200 png ok$/).click() // listed (and expanded) under the request right away
    const img = page.getByRole('region', { name: 'Example response' }).getByRole('img', { name: 'Response body' })
    await img.waitFor()
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
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
    // The example saved from the live PNG response travels in the item's `response` list.
    const image = exported.item.find((i: { name: string }) => i.name === 'Image')
    expect(image.response).toHaveLength(1)
    expect(image.response[0]).toMatchObject({ name: 'png ok', code: 200, status: 'OK', _slinger_body_encoding: 'base64', body: PNG.toString('base64') })
    expect(image.response[0].originalRequest.url.raw).toBe('{{baseUrl}}/binary.png')
  })

  it('exports the imported collection with untouched examples identical to the source file', async () => {
    await contextMenu(item(/^thub-collection/), 'Export as Postman JSON…')
    const dialog = page.getByRole('dialog', { name: 'Export collection' })
    await dialog.getByRole('button', { name: /Choose folder/ }).click()
    await dialog.getByRole('button', { name: 'Save to file' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => readdirSync(exportDir).some((f) => f.startsWith('thub-collection'))).toBe(true)
    const exported = JSON.parse(readFileSync(join(exportDir, readdirSync(exportDir).find((f) => f.startsWith('thub-collection'))!), 'utf8'))
    const original = JSON.parse(readFileSync(EXAMPLE, 'utf8'))
    expect(exported.item.map((i: { name: string }) => i.name)).toEqual(original.item.map((i: { name: string }) => i.name))
    expect(exported.item.reduce((n: number, i: { response?: unknown[] }) => n + (i.response?.length ?? 0), 0)).toBe(16)
    for (let i = 1; i < original.item.length; i++) expect(JSON.stringify(exported.item[i].response)).toBe(JSON.stringify(original.item[i].response))
    expect(exported.item[0].response[0]).toEqual({ ...original.item[0].response[0], name: 'success edited', status: 'Accepted', code: 202 })
    expect(JSON.stringify(exported.item[0].response[1])).toBe(JSON.stringify(original.item[0].response[1]))
  })
})

describe('markdown docs', () => {
  const DOCS_COLLECTION = {
    info: {
      name: 'Docs API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: [
        '# Docs API',
        '',
        'Base URL: `{{baseUrl}}`. Read the [API guide](https://docs.example.test/guide).',
        '',
        '| Endpoint | Method |',
        '|----------|--------|',
        '| /users   | GET    |',
        '',
        '![remote](https://images.example.test/logo.png) <script>window.__docsPwned = 1</script>',
      ].join('\n'),
    },
    item: [
      {
        name: 'List users',
        request: {
          method: 'GET',
          url: '{{baseUrl}}/users',
          description: { content: '## Users endpoint\n\n- [x] paginated', type: 'text/markdown' },
        },
      },
    ],
  }

  it('imports a collection with Markdown docs, renders them, and opens links in the system browser', async () => {
    const file = join(tmp, 'docs-collection.json')
    writeFileSync(file, JSON.stringify(DOCS_COLLECTION, null, 2))
    // Record instead of launching a real browser.
    await ctx.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] }
      g.__opened = []
      shell.openExternal = (async (url: string) => void g.__opened.push(url)) as never
    })
    await page.getByRole('button', { name: 'Import Postman collection' }).click()
    await page.getByLabel('Postman file').setInputFiles(file)
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click()
    await item(/^Docs API/).waitFor()

    await contextMenu(item(/^Docs API/), 'Overview & docs')
    const overview = page.getByTestId('overview-view')
    await overview.waitFor()
    const doc = overview.getByTestId('markdown-view')
    await doc.getByRole('heading', { name: /Docs API/, level: 1 }).waitFor()
    expect(await doc.getByRole('table').getByRole('cell', { name: '/users' }).count()).toBe(1)
    expect(await doc.locator('.md-var').first().innerText()).toBe('{{baseUrl}}')
    expect(await doc.locator('.md-img-blocked').innerText()).toContain('remote')
    expect(await doc.locator('script, img[src^="http"]').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { __docsPwned?: number }).__docsPwned)).toBeUndefined()

    const before = page.url()
    await doc.getByRole('link', { name: 'API guide' }).click()
    await expect
      .poll(() => ctx.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
      .toEqual(['https://docs.example.test/guide'])
    expect(page.url()).toBe(before)

    // The request's own docs ({content, type} object) render in its Docs tab.
    await item(/^Docs API/).click()
    await item(/List users$/).click()
    await page.getByRole('tab', { name: 'Docs' }).click()
    await page.getByTestId('markdown-view').getByRole('heading', { name: /Users endpoint/ }).waitFor()
    await capture(ctx.app, join(SHOTS, 'markdown-docs.png'))
    expect(ctx.problems.filter((p) => /Content Security Policy|img-src/i.test(p))).toEqual([])
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
    // authToken was written by the login request's test script (describe 'scripts').
    expect(vars.map((v) => v.key).sort()).toEqual(['authToken', 'baseUrl', 'pathPart', 'token', 'user'])
    expect(vars.find((v) => v.key === 'authToken')?.value).toBe(target.issuedTokens.at(-1))
    expect(vars.find((v) => v.key === 'token')).toMatchObject({ secret: true, value: null })

    await reveal(/Echo$/)
    await item(/Echo$/).click()
    await send()
    expect(target.requests.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('a saved file field is not granted in the new session: it says so, refuses to send, and Choose again re-grants', async () => {
    await reveal(/Upload$/, /^Col A/)
    await item(/Upload$/).click()
    await page.getByRole('tab', { name: 'Body' }).click()
    await expect.poll(() => page.getByTestId('file-status').innerText()).toContain('file not granted')
    const before = target.requests.length
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => response().innerText()).toMatch(/not granted/i)
    expect(target.requests.length).toBe(before)
    await page.getByRole('button', { name: 'Choose again' }).click()
    await expect.poll(() => page.getByTestId('file-status').innerText()).not.toContain('not granted')
    await send()
    expect(target.requests.at(-1)!.body.toString()).toContain('file-contents-for-multipart')
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
