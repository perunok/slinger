// Dev loop: Vite dev server for the renderer + Electron main process.
//   npm run electron:dev
// Main-process code is rebuilt on start only; restart to pick up main changes.
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const port = Number(process.env.SLINGER_VITE_PORT ?? 5173)
const url = `http://127.0.0.1:${port}`
const sh = process.platform === 'win32'

const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: sh })
if (run(process.execPath, ['scripts/ensure-native.mjs', 'electron']).status !== 0) process.exit(1)
if (run(process.execPath, ['scripts/build-main.mjs']).status !== 0) process.exit(1)

const vite = spawn(
  join(root, 'node_modules', '.bin', sh ? 'vite.cmd' : 'vite'),
  ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: root, stdio: 'inherit', shell: sh },
)

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Vite dev server did not start on ${url}`)
}

let electron
const shutdown = (code = 0) => {
  vite.kill()
  electron?.kill()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
vite.on('exit', (code) => shutdown(code ?? 0))

await waitForServer()
electron = spawn(require('electron'), ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SLINGER_DEV_SERVER_URL: url },
})
electron.on('exit', (code) => shutdown(code ?? 0))
