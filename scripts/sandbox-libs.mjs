// Postman's built-in script libraries (crypto-js, lodash, moment, ...) for the QuickJS script sandbox.
//
// Each library is bundled here, at build time, into one self-contained CommonJS text, wrapped as
// `(function (module, exports) { ... })`. The texts reach sandbox.ts through the virtual module
// `virtual:sandbox-libs` (esbuild plugin for the worker bundle, Vite plugin for vitest). They are only ever
// evaluated INSIDE QuickJS, on the first require() of that name in a script's context (see prelude.js).
//
// Libraries are bundled for the browser platform: Node built-ins they touch are replaced by the small shims in
// electron/scripts/libs/ (no real streams, timers or files exist in the sandbox), or by pure-JS packages
// (`events`, `buffer`).
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shim = (name) => join(root, 'electron/scripts/libs', name)

/** require() name -> entry source (CommonJS) and build options. Versions are pinned in package.json. */
export const SANDBOX_LIBRARIES = {
  // crypto-js 4.2 changed PBKDF2's defaults to SHA256 with 250000 iterations (about a minute in QuickJS); Postman ships
  // crypto-js 3.x, whose defaults are SHA1 and 1 iteration, so PBKDF2 without options gives Postman's result.
  'crypto-js': {
    entry:
      "var C = require('crypto-js'); C.algo.PBKDF2.cfg = C.algo.PBKDF2.cfg.extend({ hasher: C.algo.SHA1, iterations: 1 }); module.exports = C",
  },
  lodash: { entry: "module.exports = require('lodash')" },
  moment: { entry: "module.exports = require('moment')" },
  // Postman's uuid module is callable (v4) and has the named generators (uuid.v4(), uuid.v1(), ...).
  uuid: { entry: "var u = require('uuid'); function uuid() { return u.v4.apply(null, arguments) } Object.keys(u).forEach(function (k) { uuid[k] = u[k] }); module.exports = uuid" },
  chai: { entry: "module.exports = require('chai')" },
  tv4: { entry: "module.exports = require('tv4')" },
  ajv: { entry: "module.exports = require('ajv')" },
  xml2js: { entry: "module.exports = require('xml2js')" },
  'csv-parse/lib/sync': { entry: "module.exports = require('csv-parse/lib/sync')", buffer: true },
  cheerio: { entry: "module.exports = require('cheerio')", buffer: true },
}
// Not bundled: postman-collection (about 1.2 MB minified, mostly iconv-lite and faker; ~100 ms to load in QuickJS).

async function buildOne(name, spec) {
  const out = await build({
    stdin: { contents: spec.entry, resolveDir: root, loader: 'js', sourcefile: `sandbox-lib:${name}` },
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'eof',
    alias: { timers: shim('timers.js'), stream: shim('stream.js'), string_decoder: shim('string_decoder.js') },
    inject: spec.buffer ? [shim('buffer-global.js')] : [],
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    logLevel: 'silent',
  })
  const code = out.outputFiles[0].text
  return `(function (module, exports) {\n${code}\n})`
}

let cached = null

/** { name: wrapped source } for every library (built once per process). */
export function buildSandboxLibraries() {
  cached ??= (async () => {
    const entries = await Promise.all(Object.entries(SANDBOX_LIBRARIES).map(async ([name, spec]) => [name, await buildOne(name, spec)]))
    return Object.fromEntries(entries)
  })()
  return cached
}

const VIRTUAL_ID = 'virtual:sandbox-libs'

async function moduleText(log) {
  const libs = await buildSandboxLibraries()
  if (log) {
    const sizes = Object.entries(libs).map(([n, s]) => `${n} ${(s.length / 1024).toFixed(0)} KB`)
    const total = Object.values(libs).reduce((a, s) => a + s.length, 0)
    console.log(`sandbox libraries: ${sizes.join(', ')} (total ${(total / 1024).toFixed(0)} KB)`)
  }
  return `export default ${JSON.stringify(libs)}`
}

/** esbuild plugin providing `virtual:sandbox-libs` (worker bundle). */
export const sandboxLibsEsbuildPlugin = {
  name: 'sandbox-libs',
  setup(b) {
    b.onResolve({ filter: /^virtual:sandbox-libs$/ }, (args) => ({ path: args.path, namespace: 'sandbox-libs' }))
    b.onLoad({ filter: /.*/, namespace: 'sandbox-libs' }, async () => ({ contents: await moduleText(true), loader: 'js' }))
  },
}

/** Vite/Vitest plugin providing `virtual:sandbox-libs`. */
export function sandboxLibsVitePlugin() {
  return {
    name: 'sandbox-libs',
    resolveId(id) {
      return id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : null
    },
    async load(id) {
      return id === `\0${VIRTUAL_ID}` ? moduleText(false) : null
    },
  }
}
