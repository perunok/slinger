/**
 * Entry point of the main process (`dist-electron/main.cjs`): runs the real main bundle (`app.cjs`, from main.ts) with
 * a V8 code cache, so a launch after the first skips compiling ~2 MB of JavaScript (measured: ~93 ms -> ~55 ms to
 * evaluate the bundle). Nothing here may change behaviour: the bundle runs as an ordinary CommonJS module, and any
 * problem with the cache (missing, stale after an update, rejected by V8, unwritable) only means a normal compile.
 *
 * The cache lives in `<userData>/code-cache/` and is written once, a few seconds after startup (so the functions the
 * launch ran are in it), whenever there was none or V8 rejected it. V8 checks it against the source and its own
 * version, so an update simply writes a new one.
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import Module from 'node:module'
import { dirname, join } from 'node:path'
import { Script } from 'node:vm'

const APP_FILE = join(__dirname, 'app.cjs')
const WRITE_DELAY_MS = 10_000

function cacheFile(): string {
  // Same rule as main.ts: SLINGER_USER_DATA_DIR overrides the profile (tests, screenshots).
  const userData = process.env.SLINGER_USER_DATA_DIR || app.getPath('userData')
  return join(userData, 'code-cache', `app-${process.versions.v8}.bin`)
}

function readCache(file: string): Buffer | undefined {
  try {
    return readFileSync(file)
  } catch {
    return undefined
  }
}

function writeCache(script: Script, file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, script.createCachedData())
    renameSync(tmp, file)
  } catch {
    /* read-only or full disk: the next launch compiles normally */
  }
}

type Wrapper = (exports: unknown, require: NodeJS.Require, module: Module, filename: string, dirname: string) => void
const internals = Module as unknown as { _cache: Record<string, Module>; _nodeModulePaths(dir: string): string[] }

/** Compiles app.cjs with the cache. Throws only before any of the bundle has run. */
function prepare(): { script: Script; wrapper: Wrapper; file: string; cached: boolean } {
  const file = cacheFile()
  const cachedData = readCache(file)
  const script = new Script(Module.wrap(readFileSync(APP_FILE, 'utf8')), { filename: APP_FILE, cachedData })
  return { script, wrapper: script.runInThisContext() as Wrapper, file, cached: !!cachedData && !script.cachedDataRejected }
}

let prepared: ReturnType<typeof prepare> | null = null
try {
  prepared = prepare()
} catch {
  prepared = null
}
if (!prepared) {
  // Something is off with the cache path or the file: start the bundle the ordinary way.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(APP_FILE)
} else {
  // Exactly what require() does for a .cjs file, with our compiled wrapper. Errors from the bundle propagate as before.
  const mod = new Module(APP_FILE, module)
  mod.filename = APP_FILE
  mod.paths = internals._nodeModulePaths(__dirname)
  internals._cache[APP_FILE] = mod
  prepared.wrapper.call(mod.exports, mod.exports, Module.createRequire(APP_FILE), mod, APP_FILE, __dirname)
  mod.loaded = true
  if (!prepared.cached) {
    const { script, file } = prepared
    setTimeout(() => writeCache(script, file), WRITE_DELAY_MS).unref()
  }
}
