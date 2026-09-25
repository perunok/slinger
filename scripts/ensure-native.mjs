// better-sqlite3 is a native addon compiled against one runtime ABI at a time.
// `npm test` runs under plain Node, the app runs under Electron's embedded Node,
// so we switch the compiled binary on demand and remember which one is in place.
//
//   node scripts/ensure-native.mjs node|electron [--force]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const target = process.argv[2]
const force = process.argv.includes('--force')
if (target !== 'node' && target !== 'electron') {
  console.error('usage: ensure-native.mjs node|electron [--force]')
  process.exit(2)
}

const marker = join(root, 'node_modules', '.slinger-native-target')
const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null
const bin = (name) => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })

function loadsUnderNode() {
  try {
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
}

if (!force && current === target) process.exit(0)
if (!force && target === 'node' && current === null && loadsUnderNode()) {
  writeFileSync(marker, 'node')
  process.exit(0)
}

console.log(`[slinger] switching better-sqlite3 native build -> ${target}`)
if (target === 'node') {
  run('npm', ['rebuild', 'better-sqlite3', '--build-from-source=false'])
  if (!loadsUnderNode()) {
    // Prebuilt binary not available for this Node: compile from source.
    run('npm', ['rebuild', 'better-sqlite3', '--build-from-source'])
  }
} else {
  const electronVersion = require('electron/package.json').version
  run(bin('electron-rebuild'), ['-f', '-w', 'better-sqlite3', '-v', electronVersion])
}
writeFileSync(marker, target)
