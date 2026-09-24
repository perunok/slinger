// Builds installers: bundles main + renderer, switches better-sqlite3 to Electron's ABI,
// runs electron-builder (extra args are forwarded, e.g. `--linux dir`, `--mac --arm64`), and
// always switches better-sqlite3 back to the Node ABI so `npm test` keeps working.
//
//   node scripts/package.mjs [electron-builder args...]
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: win })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`)
}
const bin = (name) => join(root, 'node_modules', '.bin', win ? `${name}.cmd` : name)

let failed = false
try {
  run('npm', ['run', 'build'])
  run(process.execPath, ['scripts/ensure-native.mjs', 'electron'])
  run(bin('electron-builder'), process.argv.slice(2))
} catch (err) {
  console.error(String(err.message ?? err))
  failed = true
} finally {
  try {
    run(process.execPath, ['scripts/ensure-native.mjs', 'node'])
  } catch (err) {
    console.error('could not restore the Node build of better-sqlite3:', String(err.message ?? err))
    failed = true
  }
}
process.exit(failed ? 1 : 0)
