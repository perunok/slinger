/**
 * In-app updates: download the latest release's installer for this installation, verify it, install it and restart.
 *
 * - Which installer: detected from how Slinger runs (`detectInstall`): an AppImage (`$APPIMAGE`), the .deb (files under
 *   /opt/Slinger owned by dpkg), the Windows NSIS install, or a macOS app bundle. Development builds and other layouts do not
 *   update themselves (the release page still works).
 * - What is trusted: the release JSON comes from GitHub's latest-release endpoint like the update check. The installer must
 *   be the asset with the exact expected name, downloaded from github.com/perunok/slinger/releases/download (or the test
 *   feed's own origin), and its bytes must match the asset's size and GitHub's SHA-256 `digest`; anything else is refused.
 * - Installing: AppImage: the file is replaced in place (same folder, atomic rename). deb: `pkexec dpkg -i` (the desktop asks
 *   for the administrator password; cancelling it cancels the update). Windows: the installer runs silently (`/S`) and starts
 *   Slinger again (`--force-run`). macOS: after Slinger quits, a helper mounts the disk image and replaces the app bundle.
 *   Linux and macOS restart through a detached helper that waits for this process to exit first (the single-instance lock
 *   would otherwise send the new start back to this one).
 *
 * Pure Node (no Electron): fetch, spawn and the file system checks are injected; main.ts supplies quit().
 */
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import type { UpdateInstallMethod, UpdateInstallState } from '../../shared/types'
import { ioError } from '../lib/errors'
import { compare, parse } from './semver'
import { LATEST_RELEASE_API, parseRelease, RELEASES_REPO } from './updateCheck'

const DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`
const MAX_RELEASE_JSON = 1024 * 1024
/** Progress pushes at most this often while downloading. */
const PROGRESS_MS = 200

export interface InstallTarget {
  method: UpdateInstallMethod | null
  reason: string | null
  /** AppImage file, or the .app bundle (macOS). */
  target: string | null
}

export interface DetectInput {
  platform: NodeJS.Platform
  arch: string
  isPackaged: boolean
  /** $APPIMAGE */
  appImage?: string
  execPath: string
  isWritable(dir: string): boolean
  exists(path: string): boolean
  hasCommand(name: string): boolean
}

/** How this installation updates itself, or why it cannot. */
export function detectInstall(i: DetectInput): InstallTarget {
  const no = (reason: string): InstallTarget => ({ method: null, reason, target: null })
  if (!i.isPackaged) return no('This is a development build: update it from the source, or install a release.')
  if (i.platform === 'linux') {
    if (i.arch !== 'x64') return no('Releases are built for 64-bit x86 Linux only.')
    if (i.appImage) {
      return i.isWritable(dirname(i.appImage)) ? { method: 'appimage', reason: null, target: i.appImage } : no(`The folder of the AppImage (${dirname(i.appImage)}) is not writable.`)
    }
    if (i.execPath.startsWith('/opt/Slinger/') && i.exists('/var/lib/dpkg/info/slinger.list')) {
      return i.hasCommand('pkexec') ? { method: 'deb', reason: null, target: null } : no('Installing the .deb needs pkexec (polkit), which is not installed.')
    }
    return no('This copy of Slinger was not installed from the .deb or the AppImage.')
  }
  if (i.platform === 'win32') return i.arch === 'x64' ? { method: 'nsis', reason: null, target: null } : no('Releases are built for 64-bit Windows (x64) only.')
  if (i.platform === 'darwin') {
    const at = i.execPath.indexOf('.app/')
    if (at < 0) return no('Slinger is not running from an app bundle.')
    const bundle = i.execPath.slice(0, at + 4)
    return i.isWritable(dirname(bundle)) ? { method: 'dmg', reason: null, target: bundle } : no(`The folder of Slinger.app (${dirname(bundle)}) is not writable.`)
  }
  return no(`Releases are not built for ${i.platform}.`)
}

/** The release asset this installation needs. */
export function assetName(method: UpdateInstallMethod, version: string, arch: string): string {
  switch (method) {
    case 'appimage':
      return `Slinger-${version}-linux-x86_64.AppImage`
    case 'deb':
      return `Slinger-${version}-linux-amd64.deb`
    case 'nsis':
      return `Slinger-${version}-win-x64.exe`
    case 'dmg':
      return `Slinger-${version}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
  }
}

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  /** Lower-case hex SHA-256, or null when GitHub did not give one. */
  sha256: string | null
}

/** The release's assets (`assets[]` of GitHub's release JSON); entries that are not well-formed are skipped. */
export function parseAssets(body: unknown): ReleaseAsset[] {
  const list = (body as { assets?: unknown } | null)?.assets
  if (!Array.isArray(list)) return []
  const out: ReleaseAsset[] = []
  for (const a of list) {
    const o = a as Record<string, unknown>
    if (typeof o?.name !== 'string' || typeof o.browser_download_url !== 'string' || typeof o.size !== 'number') continue
    const m = typeof o.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(o.digest) : null
    out.push({ name: o.name, url: o.browser_download_url, size: o.size, sha256: m ? m[1]!.toLowerCase() : null })
  }
  return out
}

export interface UpdateInstallerDeps {
  currentVersion: string
  fetchImpl: typeof fetch
  /** The latest-release JSON (GitHub, or SLINGER_UPDATE_FEED_URL in tests; downloads may then come from its origin). */
  feedUrl: string
  install: InstallTarget
  arch: string
  /** Where installers are kept (<userData>/updates). */
  downloadDir: string
  emit(state: UpdateInstallState): void
  spawn(command: string, args: string[], options: SpawnOptions): { on(event: 'exit' | 'error', cb: (arg: unknown) => void): unknown; unref(): void }
  /** This process's id and executable (restart after quitting). */
  pid: number
  execPath: string
  /** Quits Slinger (the normal quit path). */
  quit(): void
  now?: () => number
}

export class UpdateInstaller {
  #state: UpdateInstallState
  #abort: AbortController | null = null
  #file: string | null = null

  constructor(private readonly deps: UpdateInstallerDeps) {
    this.#state = {
      method: deps.install.method,
      unsupportedReason: deps.install.reason,
      phase: 'idle',
      version: null,
      received: 0,
      total: null,
      bytesPerSec: null,
      error: null,
    }
  }

  state(): UpdateInstallState {
    return { ...this.#state }
  }

  /** Starts the download (resolves at once with the new state; progress is pushed). */
  download(): UpdateInstallState {
    const method = this.#state.method
    if (!method) throw ioError(this.#state.unsupportedReason ?? 'This installation cannot update itself.')
    if (this.#state.phase === 'downloading' || this.#state.phase === 'verifying' || this.#state.phase === 'installing') return this.state()
    this.#file = null
    this.#set({ phase: 'downloading', version: null, received: 0, total: null, bytesPerSec: null, error: null })
    const abort = new AbortController()
    this.#abort = abort
    void this.#download(method, abort.signal).then(
      () => {
        if (this.#abort === abort) this.#abort = null
      },
      (err: unknown) => {
        if (this.#abort === abort) this.#abort = null
        if (abort.signal.aborted) this.#set({ phase: 'idle', received: 0, total: null, bytesPerSec: null, error: null })
        else this.#set({ phase: 'error', bytesPerSec: null, error: (err as Error)?.message ?? String(err) })
      },
    )
    return this.state()
  }

  cancel(): UpdateInstallState {
    this.#abort?.abort()
    return this.state()
  }

  /** Installs the downloaded update and restarts. Rejects when installing failed (the state says why). */
  async install(): Promise<UpdateInstallState> {
    const method = this.#state.method
    const file = this.#file
    if (!method || this.#state.phase !== 'ready' || !file || !existsSync(file)) throw ioError('No downloaded update is ready to install.')
    this.#set({ phase: 'installing', error: null })
    try {
      switch (method) {
        case 'appimage': {
          const target = this.deps.install.target!
          const next = `${target}.new`
          copyFileSync(file, next)
          chmodSync(next, 0o755)
          renameSync(next, target)
          this.#restartAfterQuit(`exec "$0"`, target)
          break
        }
        case 'deb': {
          const code = await this.#run('pkexec', ['dpkg', '-i', file])
          if (code === 126 || code === 127) throw new Error('Installing was cancelled: the administrator password was not given.')
          if (code !== 0) throw new Error(`dpkg could not install the update (exit code ${code}).`)
          this.#restartAfterQuit(`exec "$0"`, this.deps.execPath)
          break
        }
        case 'nsis':
          // Silent install over the existing one; the installer starts Slinger again when it is done.
          this.deps.spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
          break
        case 'dmg': {
          const bundle = this.deps.install.target!
          const script = [
            'mnt=$(mktemp -d)',
            'hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$0" || exit 1',
            'app=$(ls -d "$mnt"/*.app | head -n 1)',
            '[ -n "$app" ] && ditto "$app" "$1.new" && rm -rf "$1" && mv "$1.new" "$1"',
            'hdiutil detach -quiet "$mnt"',
            'open "$1"',
          ].join('; ')
          this.#restartAfterQuit(script, file, bundle)
          break
        }
      }
    } catch (err) {
      this.#set({ phase: 'error', error: (err as Error)?.message ?? String(err) })
      throw ioError(this.#state.error!)
    }
    this.deps.quit()
    return this.state()
  }

  async #download(method: UpdateInstallMethod, signal: AbortSignal): Promise<void> {
    const { fetchImpl, feedUrl, currentVersion } = this.deps
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `Slinger/${currentVersion}`, 'X-GitHub-Api-Version': '2022-11-28' }
    let res: Response
    try {
      res = await fetchImpl(feedUrl, { headers, redirect: 'follow', signal })
    } catch (err) {
      if (signal.aborted) throw err
      throw new Error('Could not reach GitHub to download the update.')
    }
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the latest release.`)
    const text = await res.text()
    if (text.length > MAX_RELEASE_JSON) throw new Error('The release information from GitHub is too large.')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('GitHub sent release information that is not JSON.')
    }
    const release = parseRelease(body)
    if (!release) throw new Error('GitHub sent release information Slinger does not understand.')
    const current = parse(currentVersion)
    if (current && compare(release.version, current) <= 0) throw new Error(`Slinger ${currentVersion} is already the latest release.`)
    const name = assetName(method, release.version, this.deps.arch)
    const asset = parseAssets(body).find((a) => a.name === name)
    if (!asset) throw new Error(`Release ${release.version} has no ${name}.`)
    if (!this.#allowedUrl(asset.url)) throw new Error(`Refusing to download the update from ${asset.url}.`)
    if (!asset.sha256) throw new Error('GitHub gave no checksum for the installer, so it cannot be verified.')
    this.#set({ version: release.version, total: asset.size })

    mkdirSync(this.deps.downloadDir, { recursive: true })
    // Earlier downloads (other versions, broken parts) are not needed any more.
    for (const f of readdirSync(this.deps.downloadDir)) if (f !== name) rmSync(join(this.deps.downloadDir, f), { force: true, recursive: true })
    const file = join(this.deps.downloadDir, name)
    const part = `${file}.part`

    const dl = await fetchImpl(asset.url, { headers: { 'User-Agent': `Slinger/${currentVersion}` }, redirect: 'follow', signal })
    if (!dl.ok || !dl.body) throw new Error(`The download failed: HTTP ${dl.status}.`)
    const hash = createHash('sha256')
    const out = createWriteStream(part)
    const now = this.deps.now ?? Date.now
    let received = 0
    let lastPush = 0
    let windowStart = now()
    let windowBytes = 0
    let speed: number | null = null
    try {
      const reader = dl.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > asset.size) throw new Error('The download is larger than GitHub said; it was discarded.')
        hash.update(value)
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        windowBytes += value.byteLength
        const t = now()
        if (t - windowStart >= 1000) {
          speed = Math.round((windowBytes * 1000) / (t - windowStart))
          windowStart = t
          windowBytes = 0
        }
        if (t - lastPush >= PROGRESS_MS) {
          lastPush = t
          this.#set({ received, bytesPerSec: speed })
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    } catch (err) {
      out.destroy()
      rmSync(part, { force: true })
      throw err
    }
    this.#set({ phase: 'verifying', received, bytesPerSec: null })
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      rmSync(part, { force: true })
      throw new Error('The downloaded installer does not match GitHub\'s checksum; it was discarded. Try again.')
    }
    renameSync(part, file)
    this.#file = file
    this.#set({ phase: 'ready' })
  }

  #allowedUrl(url: string): boolean {
    if (url.startsWith(DOWNLOAD_PREFIX)) return true
    // A test feed (SLINGER_UPDATE_FEED_URL) may serve its installers itself.
    return this.deps.feedUrl !== LATEST_RELEASE_API && new URL(url).origin === new URL(this.deps.feedUrl).origin
  }

  /** Runs `command` and resolves with its exit code. */
  #run(command: string, args: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = this.deps.spawn(command, args, { stdio: 'ignore' })
      child.on('error', (e) => reject(new Error(`Could not start ${command}: ${(e as Error)?.message ?? e}`)))
      child.on('exit', (code) => resolve(typeof code === 'number' ? code : 1))
    })
  }

  /** A detached shell waits until this process exited, then runs `script` ($0, $1 = args). */
  #restartAfterQuit(script: string, ...args: string[]): void {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    this.deps
      .spawn('/bin/sh', ['-c', `while kill -0 ${this.deps.pid} 2>/dev/null; do sleep 0.3; done; ${script}`, ...args], { detached: true, stdio: 'ignore', env })
      .unref()
  }

  #set(patch: Partial<UpdateInstallState>): void {
    this.#state = { ...this.#state, ...patch }
    this.deps.emit(this.state())
  }
}

/** Real checks for detectInstall. */
export const installChecks = {
  isWritable(dir: string): boolean {
    try {
      accessSync(dir, constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  exists: (path: string) => existsSync(path),
  hasCommand(name: string): boolean {
    return (process.env.PATH ?? '').split(':').some((d) => d && existsSync(join(d, name)))
  },
}
