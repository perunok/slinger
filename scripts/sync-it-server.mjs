// Starts a REAL slinger-admin server against a throwaway PostgreSQL for the sync integration tests
// (electron/__tests__/sync-it). Used programmatically by the tests and from the command line:
//
//   SLINGER_SYNC_IT_SERVER_DIR=../slinger-admin/server node scripts/sync-it-server.mjs
//
// prints {"baseUrl": "...", "adminEmail": "...", "adminPassword": "..."} and keeps running until SIGINT.
// SLINGER_SYNC_IT_DATABASE_URL uses an existing database instead of starting `postgres:16-alpine` in Docker.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

async function waitFor(check, what, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      if (await check()) return
    } catch (err) {
      last = err
    }
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}

/** @param {{ serverDir?: string, databaseUrl?: string, env?: Record<string,string> }} opts */
export async function startSyncItServer(opts = {}) {
  const serverDir = resolve(opts.serverDir ?? process.env.SLINGER_SYNC_IT_SERVER_DIR ?? '')
  if (!existsSync(join(serverDir, 'package.json'))) throw new Error(`SLINGER_SYNC_IT_SERVER_DIR does not point at slinger-admin/server: ${serverDir}`)
  let databaseUrl = opts.databaseUrl ?? process.env.SLINGER_SYNC_IT_DATABASE_URL
  let container = null
  if (!databaseUrl) {
    const pgPort = await freePort()
    container = `slinger-sync-it-${randomBytes(4).toString('hex')}`
    execFileSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_PASSWORD=it', '-e', 'POSTGRES_DB=slinger', 'postgres:16-alpine'], { stdio: 'pipe' })
    await waitFor(() => {
      try {
        execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'slinger'], { stdio: 'pipe' })
        // pg_isready answers during the init phase too: require a real query.
        execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'slinger', '-tAc', 'select 1'], { stdio: 'pipe' })
        return true
      } catch {
        return false
      }
    }, 'PostgreSQL to accept connections')
    databaseUrl = `postgresql://postgres:it@127.0.0.1:${pgPort}/slinger`
  }
  const adminEmail = 'admin@example.com'
  const adminPassword = 'sync-it-admin-passphrase-1'
  const port = await freePort()
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    SLINGER_HOST: '127.0.0.1',
    SLINGER_BASE_URL: `http://127.0.0.1:${port}`,
    SLINGER_SIGNING_SECRET: randomBytes(32).toString('hex'),
    SLINGER_ADMIN_BOOTSTRAP: JSON.stringify([{ email: adminEmail, password: adminPassword, display_name: 'Admin', platform_role: 'super_admin' }]),
    SLINGER_SYNC_RATE_LIMIT_PER_MINUTE: '100000',
    SLINGER_LOGIN_RATE_MAX: '10000',
    SLINGER_LOG_LEVEL: 'warn',
    NODE_ENV: 'development',
    ...(opts.env ?? {}),
  }
  const bin = (name) => join(serverDir, 'node_modules', '.bin', name)
  execFileSync(bin('prisma'), ['migrate', 'deploy'], { cwd: serverDir, env, stdio: 'pipe' })
  const child = spawn(bin('tsx'), ['src/index.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  let exited = false
  child.on('exit', () => (exited = true))
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitFor(async () => {
      if (exited) throw new Error(`server exited:\n${log}`)
      return (await fetch(`${baseUrl}/healthz`)).ok
    }, 'the server to become healthy')
  } catch (err) {
    child.kill('SIGKILL')
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' })
    throw err
  }
  return {
    baseUrl,
    adminEmail,
    adminPassword,
    databaseUrl,
    container,
    log: () => log,
    /** Full database dump as text (only with the Docker database): to assert that no secret plaintext is stored. */
    dump() {
      if (!container) throw new Error('dump() needs the Docker database')
      return execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', 'slinger', '--data-only'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
    },
    async stop() {
      child.kill('SIGTERM')
      await sleep(200)
      if (!exited) child.kill('SIGKILL')
      if (container) {
        try {
          execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' })
        } catch {
          /* already gone */
        }
      }
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startSyncItServer()
  console.log(JSON.stringify({ baseUrl: s.baseUrl, adminEmail: s.adminEmail, adminPassword: s.adminPassword }))
  const stop = async () => {
    await s.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
