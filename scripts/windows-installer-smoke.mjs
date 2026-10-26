// Installs the Windows NSIS installer silently, checks the installed app, and uninstalls it again (release.yml, Windows).
//
//   node scripts/windows-installer-smoke.mjs <Slinger-x.y.z-win-x64.exe> [--expect-signed]
//
// 1. Signatures: the installer and the installed Slinger.exe (Valid and signed by SignPath Foundation with --expect-signed;
//    otherwise only reported).
// 2. Silent per-user install (`/S /D=<dir>`), into a fresh directory.
// 3. The installed app's built-in self-check (SLINGER_SMOKE_TEST, main.ts runSmokeTest): preload + IPC, HTTP, the script
//    sandbox, and a secret round trip through Windows Credential Manager.
// 4. One Slinger per user (the instance guard, packaged builds only): a second Slinger with another profile exits at once
//    without touching its profile while the first runs.
// 5. Silent uninstall removes the program files and the uninstall entry.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

if (process.platform !== 'win32') {
  console.error('windows-installer-smoke: Windows only')
  process.exit(2)
}
const installer = process.argv[2] && resolve(process.argv[2])
const expectSigned = process.argv.includes('--expect-signed')
if (!installer || !existsSync(installer)) {
  console.error('usage: windows-installer-smoke.mjs <installer.exe> [--expect-signed]')
  process.exit(2)
}
const version = /Slinger-(\d+\.\d+\.\d+)-win/.exec(installer)?.[1]
const work = resolve(process.env.RUNNER_TEMP || process.env.TEMP || '.', `slinger-smoke-${process.pid}`)
const dir = join(work, 'app')
const exe = join(dir, 'Slinger.exe')
const failures = []
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

function powershell(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

function signature(file) {
  const out = powershell(`$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`)
  const [status, subject = ''] = out.split('|')
  return { status, subject }
}

function checkSignature(file, label) {
  const { status, subject } = signature(file)
  if (expectSigned) check(status === 'Valid' && /SignPath Foundation/.test(subject), `${label} is signed by SignPath Foundation`, `${status} ${subject}`)
  else console.log(`info ${label} signature: ${status}${subject ? ` (${subject})` : ''}`)
}

/** Resolves with the exit code, or null when it was still running after `ms` (then it is killed). */
function run(file, args, env, ms) {
  return new Promise((done) => {
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, ms)
    child.on('exit', (code) => {
      clearTimeout(timer)
      done(code)
    })
  })
}

async function waitFor(test, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(500)
  }
  return test()
}

const uninstallEntry = () =>
  powershell(
    "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { (Get-ItemProperty $_.PSPath).DisplayName } | Where-Object { $_ -like 'Slinger*' }",
  )

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// 1. The installer's signature.
checkSignature(installer, 'installer')

// 2. Silent install. /D must be the last argument and is never quoted (NSIS rule); the path has no spaces.
const installed = spawnSync(installer, ['/S', `/D=${dir}`], { stdio: 'inherit', timeout: 300_000 })
check(installed.status === 0, 'silent install exits with 0', String(installed.status))
check(await waitFor(() => existsSync(exe), 60_000), 'Slinger.exe is installed', exe)
check(!!uninstallEntry(), 'the uninstall entry is registered')
if (existsSync(exe)) checkSignature(exe, 'installed Slinger.exe')
if (version) {
  const product = powershell(`(Get-Item -LiteralPath '${exe}').VersionInfo | ForEach-Object { "$($_.ProductName)|$($_.ProductVersion)|$($_.FileVersion)" }`)
  console.log(`info Slinger.exe version info: ${product}`)
  check(product.startsWith(`Slinger|${version}`), 'Slinger.exe product name and version', product)
}

// 3. The installed app's self-check, with its own profile and keychain namespace.
const resultFile = join(work, 'smoke.json')
const smokeCode = await run(
  exe,
  [],
  {
    SLINGER_SMOKE_TEST: '1',
    SLINGER_SMOKE_RESULT_FILE: resultFile,
    SLINGER_USER_DATA_DIR: join(work, 'smoke-profile'),
    SLINGER_KEYCHAIN_NAMESPACE: `ci-smoke-${process.pid}`,
  },
  180_000,
)
check(smokeCode === 0, 'self-check exits with 0', String(smokeCode))
let smoke = null
try {
  smoke = JSON.parse(readFileSync(resultFile, 'utf8'))
} catch (err) {
  check(false, 'self-check wrote its result', String(err))
}
if (smoke) {
  const r = smoke.result ?? {}
  console.log(`info self-check result: ${JSON.stringify(smoke)}`)
  check(smoke.ok === true, 'self-check ran', smoke.error ?? '')
  check(r.version === version, 'the app reports the installer version', String(r.version))
  check(r.hasRequire === 'undefined' && r.hasProcess === 'undefined', 'the renderer is sandboxed')
  check(r.error?.code === 'invalid_input' || !!r.error?.code, 'IPC errors keep their code', JSON.stringify(r.error))
  check(r.http?.status === 200 && r.http?.body === 'smoke-ok', 'an HTTP request goes out and comes back', JSON.stringify(r.http))
  check(r.secretRevealed === true && r.secretListed === false, 'a secret round-trips through Credential Manager', r.keychainError ?? '')
  check(r.scripts?.passed === 2 && r.scripts?.errors === 0 && r.scripts?.hmacOk === true, 'scripts run in the sandbox', JSON.stringify(r.scripts ?? r.scriptsError))
  check(r.sendRequest?.ok === true, 'pm.sendRequest works', JSON.stringify(r.sendRequest ?? r.sendRequestError))
  check(r.menu?.about === true, 'the application menu is installed', JSON.stringify(r.menu))
}

// 4. One Slinger per user.
const first = join(work, 'first')
const second = join(work, 'second')
const firstChild = spawn(exe, [], { env: { ...process.env, SLINGER_USER_DATA_DIR: first, SLINGER_HIDE_WINDOW: '1' }, stdio: 'ignore' })
const firstUp = await waitFor(() => existsSync(join(first, 'slinger.db')), 90_000)
check(firstUp, 'a first Slinger starts (its profile gets a database)')
if (firstUp) {
  await sleep(3000) // its window and the guard's pipe are up by now
  const guardKey = join(process.env.APPDATA || '', 'Slinger', 'instance-guard.key')
  check(existsSync(guardKey), 'the per-user instance-guard key exists', guardKey)
  const secondCode = await run(exe, [], { SLINGER_USER_DATA_DIR: second, SLINGER_HIDE_WINDOW: '1' }, 30_000)
  check(secondCode === 0, 'a second Slinger with another profile exits at once', String(secondCode))
  check(!existsSync(join(second, 'slinger.db')), 'the second Slinger did not open its profile')
  check(firstChild.exitCode === null, 'the first Slinger keeps running')
}
spawnSync('taskkill', ['/PID', String(firstChild.pid), '/T', '/F'], { stdio: 'ignore' })
await waitFor(() => firstChild.exitCode !== null, 15_000)
await sleep(2000) // file handles

// 5. Silent uninstall. The NSIS uninstaller copies itself to %TEMP% and returns at once, so wait for the files to go.
const uninstaller = join(dir, 'Uninstall Slinger.exe')
check(existsSync(uninstaller), 'the uninstaller is installed')
if (existsSync(uninstaller)) {
  spawnSync(uninstaller, ['/S'], { stdio: 'inherit', timeout: 120_000 })
  check(await waitFor(() => !existsSync(exe), 120_000), 'uninstall removes Slinger.exe')
  check(await waitFor(() => !uninstallEntry(), 30_000), 'uninstall removes the uninstall entry')
}

rmSync(work, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nWindows installer smoke test passed')
