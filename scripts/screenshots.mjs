#!/usr/bin/env node
/**
 * README screenshot gallery: drives the REAL built app (Electron main + production renderer, no mock backend)
 * through Playwright, with an isolated profile and a deterministic local API, and writes optimised PNGs to
 * docs/screenshots/.
 *
 *   npm run screenshots                  # build, switch native modules to Electron, capture all, switch back
 *   node scripts/screenshots.mjs --only 01,07 --no-build
 *
 * Options: --only <ids>   capture only these shots (comma-separated numeric prefixes)
 *          --no-build     skip `npm run build` (use the existing dist/ and dist-electron/)
 *          --raw          keep the unoptimised captures in test-results/screenshots-raw/
 *          --scale <n>    device scale factor (default 2)
 *
 * Data: docs/screenshots/fixtures/ (a fictional "Acme Store API" Postman collection and two environments).
 * The API it calls is served by this script on http://staging.acme-store.localhost:48400 (SLINGER_SHOTS_PORT);
 * *.localhost resolves to the loopback address, so nothing leaves the machine.
 *
 * Secrets: the window runs with SLINGER_INSECURE_TEST_KEYCHAIN=1 (an unpackaged build only), i.e. secret
 * variables live in memory instead of the OS keychain, so the run needs no unlocked desktop keyring.
 *
 * PNG optimisation uses sharp (palette PNG). It is not a project dependency: when it cannot be resolved it is
 * installed once into node_modules/.cache/slinger-screenshot-tools (the lockfile is untouched).
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screenshots')
const FIXTURES = join(OUT, 'fixtures')
const RAW = join(ROOT, 'test-results', 'screenshots-raw')
const WIDTH = 1440
const HEIGHT = 900

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const ONLY = option('--only')?.split(',').map((s) => s.trim().padStart(2, '0')) ?? null
const SCALE = Number(option('--scale') ?? 2)
const PORT = Number(process.env.SLINGER_SHOTS_PORT || 48400)
const SLOW_MS = 4000

const log = (...a) => console.log('[screenshots]', ...a)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------------------------
// Deterministic "Acme Store" API
// ---------------------------------------------------------------------------------------------------------------

const PRODUCTS = [
  { id: 'prd_7Hc2Qm', sku: 'AC-HP-200', name: 'Aurora Wireless Headphones', category: 'audio', price: { amount: 149.0, currency: 'EUR' }, rating: 4.8, reviews: 1284, inStock: true, stock: 342, tags: ['bluetooth-5.3', 'anc', 'usb-c'] },
  { id: 'prd_2Kp9Xa', sku: 'AC-EB-120', name: 'Pulse True Wireless Earbuds', category: 'audio', price: { amount: 79.0, currency: 'EUR' }, rating: 4.6, reviews: 932, inStock: true, stock: 1210, tags: ['ipx5', 'wireless-charging'] },
  { id: 'prd_4Lm1Rb', sku: 'AC-SPK-300', name: 'Nimbus Bookshelf Speakers', category: 'audio', price: { amount: 229.0, currency: 'EUR' }, rating: 4.5, reviews: 412, inStock: true, stock: 58, tags: ['wifi', 'hi-res'] },
  { id: 'prd_8Qz3Vd', sku: 'AC-SB-510', name: 'Horizon Soundbar 5.1', category: 'audio', price: { amount: 349.0, currency: 'EUR' }, rating: 4.4, reviews: 207, inStock: true, stock: 23, tags: ['dolby-atmos', 'hdmi-earc'] },
  { id: 'prd_6Tn5Wc', sku: 'AC-TT-050', name: 'Vinyl One Turntable', category: 'audio', price: { amount: 189.0, currency: 'EUR' }, rating: 4.2, reviews: 156, inStock: true, stock: 17, tags: ['bluetooth', 'belt-drive'] },
]

const ORDER = {
  id: 'ord_5Rt8Lm',
  number: 'ACM-2026-048213',
  status: 'shipped',
  placedAt: '2026-09-14T10:21:07Z',
  customer: { id: 'cus_3Fh6Pz', name: 'Mira Okafor', email: 'mira.okafor@example.com' },
  items: [
    { productId: 'prd_7Hc2Qm', name: 'Aurora Wireless Headphones', quantity: 1, unitPrice: 149.0 },
    { productId: 'prd_2Kp9Xa', name: 'Pulse True Wireless Earbuds', quantity: 2, unitPrice: 79.0 },
  ],
  shipping: 4.95,
  tax: 64.85,
  total: 376.8,
  currency: 'EUR',
  shipment: { carrier: 'PostNL', trackingNumber: 'ACM3SNL0048213', estimatedDelivery: '2026-09-17' },
  shippingAddress: { name: 'Mira Okafor', line1: '12 Harbour Lane', city: 'Rotterdam', postcode: '3011 AB', country: 'NL' },
}

const CUSTOMER = {
  id: 'cus_3Fh6Pz',
  name: 'Mira Okafor',
  email: 'mira.okafor@example.com',
  memberSince: '2021-03-02',
  loyalty: { tier: 'gold', points: 12840, nextTier: 'platinum', pointsToNextTier: 7160 },
  perks: ['free-shipping', 'early-access', 'extended-returns'],
  addresses: [
    { label: 'Home', line1: '12 Harbour Lane', city: 'Rotterdam', postcode: '3011 AB', country: 'NL', default: true },
    { label: 'Work', line1: '48 Canal Street', city: 'Rotterdam', postcode: '3012 CD', country: 'NL', default: false },
  ],
  marketing: { newsletter: true, lists: ['new-arrivals'] },
}

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Acme Store</title>
    <link>https://shop.acme-store.example</link>
    <description>Acme Store product feed</description>
${PRODUCTS.map(
  (p) => `    <item>
      <g:id>${p.sku}</g:id>
      <title>${p.name}</title>
      <g:price>${p.price.amount.toFixed(2)} ${p.price.currency}</g:price>
      <g:availability>${p.inStock ? 'in_stock' : 'out_of_stock'}</g:availability>
      <link>https://shop.acme-store.example/p/${p.id}</link>
    </item>`,
).join('\n')}
  </channel>
</rss>
`

const INVOICE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice ${ORDER.number}</title>
<style>
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; margin: 32px; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #6366f1; padding-bottom: 16px; }
  h1 { margin: 0; font-size: 26px; color: #4338ca; } .muted { color: #6b7280; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding: 8px; }
  td { padding: 10px 8px; border-bottom: 1px solid #f3f4f6; } td.num, th.num { text-align: right; }
  .total td { font-weight: 700; font-size: 16px; border-bottom: none; }
  .badge { display: inline-block; background: #dcfce7; color: #166534; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
</style></head>
<body>
  <header>
    <div><h1>Acme Store</h1><div class="muted">12 Market Square · 1012 AB Amsterdam</div></div>
    <div style="text-align:right"><div><strong>Invoice ${ORDER.number}</strong></div><div class="muted">14 September 2026</div><span class="badge">Paid</span></div>
  </header>
  <p><strong>Bill to:</strong> ${ORDER.customer.name}, ${ORDER.shippingAddress.line1}, ${ORDER.shippingAddress.postcode} ${ORDER.shippingAddress.city}</p>
  <table>
    <tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
    ${ORDER.items.map((i) => `<tr><td>${i.name}</td><td class="num">${i.quantity}</td><td class="num">€${i.unitPrice.toFixed(2)}</td><td class="num">€${(i.unitPrice * i.quantity).toFixed(2)}</td></tr>`).join('')}
    <tr><td>Shipping (PostNL)</td><td></td><td></td><td class="num">€${ORDER.shipping.toFixed(2)}</td></tr>
    <tr><td>VAT 21%</td><td></td><td></td><td class="num">€${ORDER.tax.toFixed(2)}</td></tr>
    <tr class="total"><td>Total</td><td></td><td></td><td class="num">€${ORDER.total.toFixed(2)}</td></tr>
  </table>
  <p class="muted">Thank you for shopping with Acme. Questions? Reply to this invoice or visit help.acme-store.example.</p>
</body></html>`

const REPORT_CSV = [
  'month,orders,revenue_eur,avg_basket_eur,returns',
  '2026-07,4128,318942.50,77.26,112',
  '2026-08,4671,366204.10,78.40,131',
  '2026-09,5210,421377.90,80.88,127',
].join('\n')

/** Stable per-path latency so the time chips look like a real network (and never flicker between runs). */
function latency(path) {
  let h = 0
  for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return 38 + (h % 90)
}

function startApi(port) {
  const logo = readFileSync(join(ROOT, 'build', 'icons', '256x256.png'))
  let tokenSeq = 0
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname.replace(/^\/v1/, '')
      const method = req.method ?? 'GET'
      const common = {
        'X-Request-Id': `req_${(latency(path + method) * 7919).toString(36)}`,
        'X-RateLimit-Limit': '600',
        'X-RateLimit-Remaining': '598',
        'Cache-Control': 'no-store',
        Server: 'acme-edge',
      }
      const send = (status, payload, headers = {}) => {
        const isBuf = Buffer.isBuffer(payload)
        const isText = typeof payload === 'string'
        const data = isBuf ? payload : isText ? payload : JSON.stringify(payload, null, 2)
        const type = headers['Content-Type'] ?? (isBuf ? 'application/octet-stream' : isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8')
        setTimeout(() => {
          res.writeHead(status, { ...common, ...headers, 'Content-Type': type })
          res.end(data)
        }, latency(path + method))
      }
      const json = (status, payload, headers) => send(status, payload, headers)

      if (path === '/auth/token' && method === 'POST') {
        tokenSeq++
        return json(200, {
          access_token: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGlfOGYyYSIsIm4iOj${tokenSeq}9.k3Vb9sQ2xZ`,
          token_type: 'Bearer',
          expires_in: 900,
          scope: 'catalog:read catalog:write orders:write',
        })
      }
      if (path === '/auth/me') return json(200, { client: 'cli_8f2a61d0c4', name: 'Storefront (staging)', scopes: ['catalog:read', 'catalog:write', 'orders:write'] })
      if (path === '/products' && method === 'GET') {
        const cat = url.searchParams.get('category')
        const data = PRODUCTS.filter((p) => !cat || p.category === cat).sort((a, b) => b.rating - a.rating)
        return json(200, { data, next: 'eyJvZmZzZXQiOjIwfQ', total: 38 }, {
          ETag: 'W/"5c-1f3a9d"',
          'Set-Cookie': ['acme_session=s%3A9fK2qLm7Tz; Path=/; HttpOnly; Secure; SameSite=Lax', 'ab_bucket=checkout-v2; Path=/; Max-Age=2592000'],
        })
      }
      if (path === '/products' && method === 'POST') {
        return json(201, { id: 'prd_9Wn4Te', ...JSON.parse(body.toString() || '{}'), published: false, createdAt: '2026-09-20T14:03:11Z' }, { Location: '/v1/products/prd_9Wn4Te' })
      }
      if (path === '/products/feed.xml') return send(200, FEED_XML, { 'Content-Type': 'application/xml; charset=utf-8' })
      let m = path.match(/^\/products\/([\w]+)\/images$/)
      if (m && method === 'POST') {
        return json(201, { id: 'img_3Xp7', productId: m[1], url: `https://cdn.acme-store.example/p/${m[1]}/1.png`, bytes: body.length, primary: true })
      }
      m = path.match(/^\/products\/([\w]+)$/)
      if (m) {
        const p = PRODUCTS.find((x) => x.id === m[1])
        if (!p) return json(404, { type: 'https://docs.acme-store.example/errors/not-found', status: 404, title: 'Product not found' }, { 'Content-Type': 'application/problem+json' })
        if (method === 'PATCH') return json(200, { ...p, ...JSON.parse(body.toString() || '{}'), updatedAt: '2026-09-20T14:05:42Z' })
        return json(200, { ...p, updatedAt: '2026-09-18T09:12:44Z' })
      }
      if (path === '/assets/logo.png') return send(200, logo, { 'Content-Type': 'image/png' })
      if (path === '/orders' && method === 'GET') {
        return json(200, { data: [ORDER, { ...ORDER, id: 'ord_4Qw2Ha', number: 'ACM-2026-047990', total: 149.0, placedAt: '2026-09-11T08:02:44Z' }], next: null })
      }
      if (path === '/orders' && method === 'POST') return json(201, { ...ORDER, status: 'pending' }, { Location: `/v1/orders/${ORDER.id}` })
      if (path === `/orders/${ORDER.id}/invoice`) return send(200, INVOICE_HTML, { 'Content-Type': 'text/html; charset=utf-8' })
      if (path === `/orders/${ORDER.id}/shipping-address`) return json(200, { ...ORDER.shippingAddress, ...JSON.parse(body.toString() || '{}') })
      if (path === `/orders/${ORDER.id}`) {
        if (method === 'DELETE') return json(200, { id: ORDER.id, status: 'cancelled', refund: { amount: ORDER.total, currency: 'EUR', status: 'pending' } })
        return json(200, ORDER)
      }
      if (path === '/reports/orders') {
        return setTimeout(() => send(200, REPORT_CSV, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders-2026-Q3.csv"' }), SLOW_MS)
      }
      if (path === `/customers/${CUSTOMER.id}/loyalty`) {
        return json(503, { type: 'https://docs.acme-store.example/errors/upstream', status: 503, title: 'Rewards service unavailable', retryAfter: 30 }, { 'Content-Type': 'application/problem+json', 'Retry-After': '30' })
      }
      if (path === `/customers/${CUSTOMER.id}/newsletter`) return json(200, { subscribed: true, lists: ['new-arrivals', 'deals'], frequency: 'weekly' })
      if (path === `/customers/${CUSTOMER.id}/orders`) return json(200, { data: [{ id: ORDER.id, number: ORDER.number, status: ORDER.status, total: ORDER.total }], next: null })
      if (path === `/customers/${CUSTOMER.id}`) return json(200, CUSTOMER)
      return json(404, { type: 'https://docs.acme-store.example/errors/not-found', status: 404, title: 'Not found', path: url.pathname }, { 'Content-Type': 'application/problem+json' })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // No host: dual-stack, so both ::1 and 127.0.0.1 (what *.localhost resolves to) reach it.
    server.listen(port, () => resolve(server))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// App driving
// ---------------------------------------------------------------------------------------------------------------

let app
let page
const problems = []

async function launch(userDataDir, uploadFile) {
  const args = ['.', `--force-device-scale-factor=${SCALE}`]
  if (process.env.CI || process.getuid?.() === 0) args.push('--no-sandbox')
  const env = {
    ...process.env,
    SLINGER_USER_DATA_DIR: userDataDir,
    SLINGER_HIDE_WINDOW: '1',
    SLINGER_INSECURE_TEST_KEYCHAIN: '1',
    // The one light theme the app picks before any appearance is stored; replaced right after launch.
    LANG: 'en_GB.UTF-8',
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args, cwd: ROOT, env })
  app.process().stderr?.on('data', (d) => {
    const s = String(d)
    if (/IN MEMORY|error/i.test(s) && !/Debugger|DevTools/.test(s)) process.stderr.write(`[main] ${s}`)
  })
  page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`))
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.setDefaultTimeout(10_000)
  await ready()
  // "Choose file" answers with the product photo instead of opening a native dialog.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, uploadFile)
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h), { w: WIDTH, h: HEIGHT })
}

async function ready() {
  await page.waitForSelector('[aria-label="Sidebar"]', { timeout: 30_000 })
  await page.waitForSelector('#boot-skeleton', { state: 'detached', timeout: 30_000 })
}

async function reload() {
  await page.reload()
  await ready()
}

/** Theme + accent exactly as the Settings dialog stores and applies them (without a reload). */
async function appearance(theme, accent = 'theme', loader = 'random') {
  await page.evaluate(
    ({ theme, accent, loader }) => {
      localStorage.setItem('slinger.appearance', JSON.stringify({ v: 1, theme, accent, systemLight: 'github-light', systemDark: 'tokyo-night', loader }))
      const root = document.documentElement
      root.setAttribute('data-theme', theme)
      if (accent === 'theme') root.removeAttribute('data-accent')
      else root.setAttribute('data-accent', accent)
    },
    { theme, accent, loader },
  )
}

async function capture(file) {
  // Let transitions, fonts and CodeMirror measurement settle; drop the text caret and hover leftovers.
  await page.evaluate(() => document.fonts.ready)
  await sleep(350)
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  mkdirSync(RAW, { recursive: true })
  writeFileSync(join(RAW, file), Buffer.from(base64, 'base64'))
}

const tree = () => page.getByRole('tree', { name: 'Collections' })
const treeItem = (name) => tree().getByRole('treeitem', { name })
const response = () => page.getByRole('region', { name: 'Response' })
const reqSection = (name) => page.getByRole('tablist', { name: 'Request sections' }).getByRole('tab', { name })
const respView = (name) => page.getByRole('tablist', { name: 'Response views' }).getByRole('tab', { name })
const exactName = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

/** Sets a tree row (collection/folder) open or closed; the expanded set is persisted, so check first. */
async function expand(name, open = true) {
  const row = treeItem(new RegExp(`^${name}`)).first()
  if (((await row.getAttribute('aria-expanded')) === 'true') !== open) await row.click()
}

/** Expands `folder` (when collapsed) and opens `request`. */
async function openRequest(folder, request) {
  const row = treeItem(new RegExp(`${request.replace(/[()]/g, '\\$&')}$`))
  if ((await row.count()) === 0) {
    await treeItem(new RegExp(`^${folder}`)).click()
    await row.first().waitFor()
  }
  await row.first().click()
  await page.getByRole('tab', { name: new RegExp(request.replace(/[()]/g, '\\$&')) }).first().waitFor()
}

async function send() {
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await response().getByTestId('status-chip').waitFor({ timeout: 15_000 })
  await sleep(500) // loader finish animation
}

async function closeAllTabs() {
  const tabs = page.getByRole('tablist', { name: 'Open requests' }).getByRole('tab')
  if ((await tabs.count()) === 0) return
  await tabs.first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close all' }).click()
  const discard = page.getByRole('button', { name: /Don.t save|Discard/ })
  if (await discard.count()) await discard.first().click()
}

async function escapeAll() {
  for (let i = 0; i < 3 && (await page.getByRole('dialog').count()) > 0; i++) {
    await page.keyboard.press('Escape')
    await sleep(150)
  }
}

async function mouseAway() {
  await page.mouse.move(WIDTH - 4, HEIGHT - 4)
}

// ---------------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------------

async function apiHost() {
  const host = 'staging.acme-store.localhost'
  try {
    await lookup(host)
    return `${host}:${PORT}`
  } catch {
    log(`${host} does not resolve here; using 127.0.0.1`)
    return `127.0.0.1:${PORT}`
  }
}

async function seed() {
  const host = await apiHost()
  const collection = readFileSync(join(FIXTURES, 'acme-store.postman_collection.json'), 'utf8')
  const staging = JSON.parse(readFileSync(join(FIXTURES, 'acme-staging.postman_environment.json'), 'utf8'))
  const production = JSON.parse(readFileSync(join(FIXTURES, 'acme-production.postman_environment.json'), 'utf8'))
  for (const v of staging.values) if (v.key === 'baseUrl') v.value = `http://${host}/v1`
  await page.evaluate(
    async ({ collection, envs }) => {
      const s = window.slinger
      const ws = (await s.listWorkspaces())[0]
      await s.renameWorkspace(ws.id, 'Acme')
      await s.importPostmanCollection(ws.id, collection)
      for (const env of envs) {
        const e = await s.createEnvironment(ws.id, env.name)
        for (const v of env.values) await s.upsertEnvironmentVariable({ environmentId: e.id, key: v.key, value: v.value, isSecret: v.type === 'secret' })
      }
      // The first-run "Local" environment would only be clutter in the switcher.
      for (const e of await s.listEnvironments(ws.id)) if (!envs.some((x) => x.name === e.name)) await s.deleteEnvironment(e.id).catch(() => {})
    },
    { collection, envs: [production, staging] },
  )
  await reload()
  await page.getByLabel('Active environment').selectOption({ label: 'Acme Staging' })
  await treeItem(/^Acme Store API/).waitFor()
}

/** Picks the product photo for the upload request's file field and saves it, so sends and runs can use it. */
async function prepareUpload() {
  await openRequest('Products', 'Upload product image')
  await reqSection('Body').click()
  await page.getByRole('button', { name: /Choose (file|again)/ }).first().click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).and(page.locator('[disabled]')).waitFor()
}

/** 1.0.0 → edits → 1.1.0 → edits → 2.0.0-beta.1, so the Versions dialog has history and a meaningful diff. */
async function seedVersions() {
  await page.evaluate(async () => {
    const s = window.slinger
    const ws = (await s.listWorkspaces())[0]
    const col = (await s.listCollections(ws.id)).find((c) => c.name === 'Acme Store API')
    const folders = await s.listFolders(col.id)
    const folder = (name) => folders.find((f) => f.name === name)
    const reqs = async () => s.listRequests(col.id)
    const find = async (name) => (await reqs()).find((r) => r.name === name)
    const update = async (name, patch) => {
      const r = await find(name)
      const doc = JSON.parse(r.documentJson)
      const next = patch(doc, r)
      if (next.url) doc.url = next.url
      if (next.method) doc.method = next.method
      await s.updateRequest({ requestId: r.id, name: next.name ?? r.name, method: next.method ?? r.method, url: next.url ?? r.url, documentJson: JSON.stringify(doc), expectedVersion: r.version })
    }
    await s.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'First public cut of the Acme Store API collection' })
    await update('List products', (doc) => {
      doc.headers = [...(doc.headers ?? []), { key: 'X-Client-Version', value: '2026.9', type: 'text' }]
      return {}
    })
    await s.createRequest({
      workspaceId: ws.id, collectionId: col.id, folderId: folder('Customers').id, name: 'Customer orders', method: 'GET',
      url: '{{baseUrl}}/customers/{{userId}}/orders?limit=5', documentJson: JSON.stringify({ headers: [{ key: 'Accept', value: 'application/json', type: 'text' }], body: null }),
    })
    await s.createCollectionVersion({ collectionId: col.id, version: '1.1.0', notes: 'Customer order history, client version header' })
    await update('Update price', () => ({ name: 'Update product', url: '{{baseUrl}}/products/{{productId}}?notify=true' }))
    await update('Cancel order', () => ({ method: 'POST', url: '{{baseUrl}}/orders/{{orderId}}/cancel' }))
    await update('Create order', (doc) => {
      doc.headers = [...(doc.headers ?? []), { key: 'X-Acme-Api-Version', value: '2', type: 'text' }]
      return {}
    })
    await s.createRequest({
      workspaceId: ws.id, collectionId: col.id, folderId: folder('Orders').id, name: 'Refund order', method: 'POST',
      url: '{{baseUrl}}/orders/{{orderId}}/refunds', documentJson: JSON.stringify({ headers: [{ key: 'Content-Type', value: 'application/json', type: 'text' }], body: { mode: 'raw', raw: '{\n  "amount": 79.0,\n  "reason": "damaged"\n}' } }),
    })
    const legacy = await find('Who am I')
    await s.deleteRequest(legacy.id)
    await s.createCollectionVersion({ collectionId: col.id, version: '2.0.0-beta.1', notes: 'v2 API: cancel is a POST action, /auth/me removed' })
  })
  await reload()
}

// ---------------------------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------------------------

/** Every shot: file name, theme, accent, and how to get the UI there (starting from a clean main view). */
const SHOTS = [
  {
    file: '01-main.png', title: 'Collections, requests and a pretty JSON response', theme: 'tokyo-night', accent: 'theme', split: 0.46,
    async run() {
      await expand('Auth')
      await expand('Customers', false)
      await openRequest('Products', 'List products')
      await reqSection('Params').click()
      await send()
      await respView('Pretty').click()
    },
  },
  {
    file: '02-variables.png', title: '{{variable}} highlighting; the hover popover keeps secrets masked', theme: 'dracula', accent: 'theme',
    async run() {
      await openRequest('Auth', 'Request access token')
      await reqSection('Body').click()
      await send()
      const secret = page.locator('#request-panel .cm-tpl-secret').first()
      await secret.hover()
      await page.getByTestId('template-popover').waitFor()
    },
    keepMouse: true,
    keepFocus: true,
  },
  {
    file: '03-environments.png', title: 'Environments with a masked secret and the environment switcher', theme: 'catppuccin-mocha', accent: 'theme',
    async run() {
      await openRequest('Customers', 'Get customer')
      await page.getByRole('button', { name: 'Manage environments' }).click()
      const dialog = page.getByRole('dialog', { name: 'Environments' })
      await dialog.waitFor()
      const staging = dialog.getByRole('button', { name: /Acme Staging/ }).or(dialog.getByRole('option', { name: /Acme Staging/ }))
      if (await staging.count()) await staging.first().click()
    },
  },
  {
    file: '04-body-form-data.png', title: 'Multipart form-data with a file field', theme: 'one-dark', accent: 'theme',
    async run() {
      await openRequest('Products', 'Upload product image')
      await reqSection('Body').click()
      await send()
    },
  },
  {
    file: '05-html-preview.png', title: 'HTML preview of a response', theme: 'github-dark', accent: 'theme', split: 0.3,
    async run() {
      await openRequest('Orders', 'Order invoice (HTML)')
      await reqSection('Headers').click()
      await send()
      await respView('Preview').click()
    },
  },
  {
    file: '06-scripts.png', title: 'Collection pre-request script (pm.sendRequest, CryptoJS) with pm.* autocomplete', theme: 'nord', accent: 'theme',
    async run() {
      await treeItem(/^Acme Store API/).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Scripts…' }).click()
      const dialog = page.getByRole('dialog', { name: /^Scripts/ })
      await dialog.getByRole('tablist', { name: 'Script type' }).getByRole('tab', { name: /^Pre-request/ }).click()
      await dialog.getByRole('textbox', { name: 'Pre-request script' }).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.press('Enter')
      await page.keyboard.type('pm.environment.', { delay: 40 })
      await page.locator('.cm-tooltip-autocomplete').waitFor()
    },
    keepFocus: true,
    after: async () => {
      // Drop the typed line again, so closing the dialog asks nothing.
      await page.keyboard.press('Escape')
      await page.keyboard.press('ControlOrMeta+z')
      await page.keyboard.press('ControlOrMeta+z')
    },
  },
  {
    file: '07-tests.png', title: 'Test results with a failing assertion', theme: 'rose-pine', accent: 'theme', split: 0.4,
    async run() {
      await openRequest('Customers', 'Loyalty balance')
      await reqSection(/^Scripts/).click()
      await send()
      await respView(/^Tests/).click()
    },
  },
  {
    file: '08-console.png', title: 'Script console with the pm.sendRequest call', theme: 'midnight', accent: 'theme',
    async run() {
      await openRequest('Orders', 'Get order')
      await reqSection('Headers').click()
      await send()
      await respView(/^Console/).click()
    },
  },
  {
    file: '09-runner.png', title: 'Collection runner', theme: 'tokyo-night', accent: 'violet',
    async run() {
      await treeItem(/^Acme Store API/).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Run collection…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: /^Run \d/ }).click()
      await dialog.getByRole('button', { name: 'Run again' }).waitFor({ timeout: 60_000 })
    },
  },
  {
    file: '10-loading.png', title: 'The sending animation on a slow request', theme: 'catppuccin-mocha', accent: 'orange',
    loader: 'runner', reload: true,
    async run() {
      await openRequest('Orders', 'Quarterly report (slow)')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await sleep(1700)
    },
    after: async () => {
      await response().getByTestId('status-chip').waitFor({ timeout: 15_000 })
    },
  },
  {
    file: '11-versions.png', title: 'Semantic versions and a compare diff', theme: 'gruvbox-dark', accent: 'theme',
    async run() {
      await treeItem(/^Acme Store API/).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Versions…' }).click()
      const dialog = page.getByRole('dialog', { name: /^Versions/ })
      await dialog.getByRole('option', { name: /1\.1\.0/ }).click()
      await dialog.getByRole('tab', { name: 'Compare' }).click()
      const beta = await dialog.locator('#cmp-target option', { hasText: '2.0.0-beta.1' }).getAttribute('value')
      await dialog.locator('#cmp-target').selectOption(beta)
      await sleep(400)
    },
  },
  {
    file: '12-import.png', title: 'Import: paste JSON, detected format, replace or copy', theme: 'one-dark', accent: 'teal',
    async run() {
      const exported = readFileSync(join(FIXTURES, 'acme-store.postman_collection.json'), 'utf8')
      const withHistory = await page.evaluate(async (text) => {
        // The same file as exported by Slinger: info.version plus the version history (info._slinger).
        const s = window.slinger
        const ws = (await s.listWorkspaces())[0]
        const col = (await s.listCollections(ws.id)).find((c) => c.name === 'Acme Store API')
        const versions = (await s.listCollectionVersions(col.id)).reverse()
        const doc = JSON.parse(text)
        doc.info.version = versions.at(-1).version
        doc.info._slinger = {
          formatVersion: 1,
          exportedAt: '2026-09-21T08:30:00Z',
          app: `Slinger ${await s.getAppVersion()}`,
          collectionId: col.id,
          includesSnapshots: true,
          versions: await Promise.all(
            versions.map(async (v) => {
              const d = await s.getCollectionVersion(v.id)
              return { version: v.version, notes: v.notes, createdAt: '2026-09-20T12:00:00Z', folderCount: d.snapshot.folders.length, requestCount: d.snapshot.requests.length, snapshot: d.snapshot }
            }),
          ),
        }
        return JSON.stringify(doc, null, 2)
      }, exported)
      await page.getByRole('button', { name: 'Import collection or environment' }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Import' })
      // fill() types 50+ KB through the input pipeline and is slow; set the value like a paste would.
      await dialog.getByLabel('Or paste JSON').evaluate((el, text) => {
        el.value = text
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.scrollTop = 0
      }, withHistory)
      await dialog.getByTestId('import-history').waitFor()
      await sleep(400)
    },
  },
  {
    file: '13-docs.png', title: 'Markdown docs: collection overview', theme: 'github-light', accent: 'theme', light: true,
    async run() {
      await treeItem(/^Acme Store API/).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Overview & docs' }).click()
      await page.getByTestId('overview-view').getByTestId('markdown-view').waitFor()
    },
  },
  {
    file: '14-settings-themes.png', title: 'Settings: 31 themes and 18 accents', theme: 'tokyo-night', accent: 'theme', reload: true,
    async run() {
      await page.getByRole('button', { name: 'Settings' }).click()
      const dialog = page.getByRole('dialog', { name: /Settings/ })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: 'Dark', exact: true }).or(dialog.getByRole('radio', { name: 'Dark', exact: true })).first().click()
      await dialog.getByText(/^Accent/).first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
    },
  },
  {
    file: '15-command-palette.png', title: 'Ctrl+K command palette: themes, accents, import/export', theme: 'dracula', accent: 'pink', reload: true,
    async run() {
      await openRequest('Products', 'List products')
      await send()
      await page.keyboard.press('ControlOrMeta+k')
      await page.getByRole('combobox', { name: 'Search requests and commands' }).fill('> ')
      for (let i = 0; i < 29; i++) await page.keyboard.press('ArrowDown')
      await sleep(300)
    },
    keepFocus: true,
  },
  {
    file: '16-about.png', title: 'About Slinger and the Sling Manifesto', theme: 'rose-pine', accent: 'theme',
    async run() {
      await page.getByRole('button', { name: /About/ }).first().click()
      const dialog = page.getByRole('dialog', { name: /About/ })
      await dialog.waitFor()
      await dialog.getByText(/Sling Manifesto/).first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
    },
  },
  {
    file: '17-example.png', title: 'Saved examples', theme: 'nord', accent: 'theme',
    async run() {
      await expand('Products')
      const row = treeItem(/List products$/)
      await row.getByTestId('examples-toggle').click()
      await treeItem(/200 Audio, best rated/).click()
      await page.getByTestId('example-view').waitFor()
    },
  },
  {
    file: '18-code-snippet.png', title: 'Code snippets (cURL, fetch, …)', theme: 'monokai', accent: 'theme', split: 0.62,
    async run() {
      await openRequest('Orders', 'Create order')
      await send()
      await reqSection('Code').click()
    },
  },
  {
    file: '19-history.png', title: 'Request history', theme: 'catppuccin-latte', accent: 'theme', light: true, sidebar: 0.36,
    async run() {
      await openRequest('Customers', 'Get customer')
      await send()
      await page.getByRole('tab', { name: 'History' }).click()
    },
    after: async () => page.getByRole('tab', { name: 'Collections' }).click(),
  },
]

// ---------------------------------------------------------------------------------------------------------------
// Optimisation
// ---------------------------------------------------------------------------------------------------------------

async function loadSharp() {
  const fromProject = createRequire(join(ROOT, 'package.json'))
  try {
    return fromProject('sharp')
  } catch {
    /* not a project dependency */
  }
  const toolsDir = join(ROOT, 'node_modules', '.cache', 'slinger-screenshot-tools')
  const fromTools = createRequire(join(toolsDir, 'package.json'))
  try {
    return fromTools('sharp')
  } catch {
    log('installing sharp into', toolsDir)
    mkdirSync(toolsDir, { recursive: true })
    if (!existsSync(join(toolsDir, 'package.json'))) writeFileSync(join(toolsDir, 'package.json'), '{ "private": true }\n')
    run(npm, ['install', '--prefix', toolsDir, '--no-audit', '--no-fund', 'sharp@0.34'])
    return fromTools('sharp')
  }
}

async function optimise(files) {
  const sharp = await loadSharp()
  let total = 0
  for (const file of files) {
    const input = readFileSync(join(RAW, file))
    const output = await sharp(input).png({ palette: true, colours: 256, quality: 92, dither: 0.6, effort: 10, compressionLevel: 9 }).toBuffer()
    writeFileSync(join(OUT, file), output)
    total += output.length
    log(`${file}: ${(input.length / 1024).toFixed(0)} KB -> ${(output.length / 1024).toFixed(0)} KB`)
  }
  log(`total ${(total / 1024 / 1024).toFixed(2)} MB for ${files.length} files`)
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  if (!flag('--no-build')) {
    run(npm, ['run', 'build'])
    run(process.execPath, ['scripts/ensure-native.mjs', 'electron'])
  }
  const api = await startApi(PORT)
  const tmp = mkdtempSync(join(tmpdir(), 'slinger-screenshots-'))
  const captured = []
  let previousSidebar = false
  try {
    const upload = join(tmp, 'headphones-front.png')
    writeFileSync(upload, readFileSync(join(ROOT, 'build', 'icons', '512x512.png')))
    await launch(join(tmp, 'user-data'), upload)
    await appearance('tokyo-night')
    await seed()
    await seedVersions()
    await page.getByLabel('Active environment').selectOption({ label: 'Acme Staging' })
    // Warm-up send, so history has more than one entry and the first shot is not the first send.
    for (const [folder, name] of [['Products', 'Get product'], ['Orders', 'List orders'], ['Products', 'Catalog feed (XML)']]) {
      await openRequest(folder, name)
      await send()
    }
    await prepareUpload()
    await closeAllTabs()
    for (const shot of SHOTS) {
      const id = shot.file.slice(0, 2)
      if (ONLY && !ONLY.includes(id)) continue
      log(`${shot.file} (${shot.theme}${shot.accent !== 'theme' ? ` / ${shot.accent}` : ''})`)
      await appearance(shot.theme, shot.accent, shot.loader ?? 'random')
      await page.evaluate(({ request, sidebar }) => {
        localStorage.setItem('slinger.split.request', String(request))
        localStorage.setItem('slinger.split.sidebar', String(sidebar))
      }, { request: shot.split ?? 0.5, sidebar: shot.sidebar ?? 0.24 })
      if (shot.reload || shot.sidebar || previousSidebar) await reload()
      previousSidebar = !!shot.sidebar
      try {
        await shot.run()
      } catch (err) {
        await capture(`FAILED-${shot.file}`).catch(() => {})
        throw err
      }
      if (!shot.keepMouse) await mouseAway()
      // No text caret in the picture (the autocomplete shot keeps its editor focused).
      if (!shot.keepFocus) await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await capture(shot.file)
      captured.push(shot.file)
      await shot.after?.()
      await escapeAll()
      await closeAllTabs()
      await mouseAway()
    }
  } finally {
    await app?.close().catch(() => {})
    api.close()
    rmSync(tmp, { recursive: true, force: true })
    if (!flag('--no-build')) run(process.execPath, ['scripts/ensure-native.mjs', 'node'])
  }
  if (problems.length) log('renderer problems:\n  ' + problems.join('\n  '))
  await optimise(captured)
  if (!flag('--raw')) for (const f of captured) rmSync(join(RAW, f), { force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
