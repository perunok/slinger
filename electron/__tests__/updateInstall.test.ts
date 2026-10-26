import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInstallState } from '../../shared/types'
import { assetName, detectInstall, parseAssets, UpdateInstaller, type DetectInput, type InstallTarget } from '../services/updateInstall'

const yes = () => true
const base: DetectInput = { platform: 'linux', arch: 'x64', isPackaged: true, execPath: '/opt/Slinger/slinger', isWritable: yes, exists: yes, hasCommand: yes }

describe('detectInstall', () => {
  it('knows each installation kind, and says why it cannot update otherwise', () => {
    expect(detectInstall(base)).toEqual({ method: 'deb', reason: null, target: null })
    expect(detectInstall({ ...base, appImage: '/home/a/Apps/Slinger.AppImage' })).toEqual({ method: 'appimage', reason: null, target: '/home/a/Apps/Slinger.AppImage' })
    expect(detectInstall({ ...base, platform: 'win32', execPath: 'C:\\Slinger\\Slinger.exe' }).method).toBe('nsis')
    expect(detectInstall({ ...base, platform: 'darwin', arch: 'arm64', execPath: '/Applications/Slinger.app/Contents/MacOS/Slinger' })).toEqual({
      method: 'dmg',
      reason: null,
      target: '/Applications/Slinger.app',
    })
    expect(detectInstall({ ...base, isPackaged: false }).reason).toContain('development build')
    expect(detectInstall({ ...base, arch: 'arm64' }).reason).toContain('64-bit x86')
    expect(detectInstall({ ...base, appImage: '/ro/Slinger.AppImage', isWritable: () => false }).reason).toContain('not writable')
    expect(detectInstall({ ...base, hasCommand: () => false }).reason).toContain('pkexec')
    expect(detectInstall({ ...base, execPath: '/usr/local/bin/slinger' }).reason).toContain('not installed from the .deb')
    expect(detectInstall({ ...base, platform: 'darwin', execPath: '/Applications/Slinger.app/Contents/MacOS/Slinger', isWritable: () => false }).reason).toContain('not writable')
  })

  it('names the asset of each kind like the release workflow does', () => {
    expect(assetName('deb', '1.2.3', 'x64')).toBe('Slinger-1.2.3-linux-amd64.deb')
    expect(assetName('appimage', '1.2.3', 'x64')).toBe('Slinger-1.2.3-linux-x86_64.AppImage')
    expect(assetName('nsis', '1.2.3', 'x64')).toBe('Slinger-1.2.3-win-x64.exe')
    expect(assetName('dmg', '1.2.3', 'arm64')).toBe('Slinger-1.2.3-mac-arm64.dmg')
    expect(assetName('dmg', '1.2.3', 'x64')).toBe('Slinger-1.2.3-mac-x64.dmg')
  })

  it('reads assets with their SHA-256 digest', () => {
    expect(
      parseAssets({
        assets: [
          { name: 'a.deb', browser_download_url: 'https://x/a.deb', size: 3, digest: `sha256:${'AB'.repeat(32)}` },
          { name: 'b.deb', browser_download_url: 'https://x/b.deb', size: 3 },
          { name: 5 },
        ],
      }),
    ).toEqual([
      { name: 'a.deb', url: 'https://x/a.deb', size: 3, sha256: 'ab'.repeat(32) },
      { name: 'b.deb', url: 'https://x/b.deb', size: 3, sha256: null },
    ])
  })
})

describe('UpdateInstaller', () => {
  let server: Server
  let origin: string
  let dir: string
  let payload: Buffer
  let release: Record<string, unknown>
  let slowMs = 0
  const states: UpdateInstallState[] = []
  const spawned: Array<{ command: string; args: string[]; detached?: boolean }> = []
  let exitCode = 0
  let stagedCheck: ((path: string) => void) | null = null
  const quit = vi.fn()

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slinger-update-'))
    mkdirSync(join(dir, 'staging'))
    payload = Buffer.alloc(300_000, 7)
    slowMs = 0
    states.length = 0
    spawned.length = 0
    exitCode = 0
    stagedCheck = null
    quit.mockReset()
    server = createServer((req, res) => {
      if (req.url === '/latest') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(release))
      }
      if (req.url?.startsWith('/dl/')) {
        res.writeHead(200, { 'content-length': String(payload.length) })
        // Two halves, the second after a pause (progress, cancel).
        res.write(payload.subarray(0, payload.length / 2))
        return setTimeout(() => res.end(payload.subarray(payload.length / 2)), slowMs)
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    release = asRelease('0.20.0', 'Slinger-0.20.0-linux-amd64.deb')
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
    rmSync(dir, { recursive: true, force: true })
  })

  function asRelease(version: string, name: string, over: Record<string, unknown> = {}) {
    return {
      tag_name: `v${version}`,
      assets: [{ name, browser_download_url: `${origin}/dl/${name}`, size: payload.length, digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`, ...over }],
    }
  }

  function make(install: InstallTarget = { method: 'deb', reason: null, target: null }, feedPath = '/latest') {
    return new UpdateInstaller({
      currentVersion: '0.19.0',
      fetchImpl: fetch,
      feedUrl: `${origin}${feedPath}`,
      install,
      arch: 'x64',
      downloadDir: join(dir, 'updates'),
      emit: (s) => void states.push(s),
      spawn: (command, args, options) => {
        spawned.push({ command, args, detached: options.detached })
        if (command === 'pkexec') stagedCheck?.(args[2]!)
        const handlers: Record<string, (a: unknown) => void> = {}
        setTimeout(() => handlers.exit?.(exitCode), 5)
        return { on: (e: string, cb: (a: unknown) => void) => void (handlers[e] = cb), unref: () => {} } as never
      },
      pid: 4242,
      execPath: '/opt/Slinger/slinger',
      quit,
      stagingRoot: join(dir, 'staging'),
    })
  }
  const settled = (u: UpdateInstaller) => expect.poll(() => u.state().phase, { timeout: 5000 }).not.toMatch(/downloading|verifying/)

  it('downloads the installer with progress, verifies it and is ready', async () => {
    const u = make()
    expect(u.download()).toMatchObject({ phase: 'downloading', method: 'deb' })
    await settled(u)
    expect(u.state()).toMatchObject({ phase: 'ready', version: '0.20.0', received: payload.length, total: payload.length, error: null })
    expect(states.map((s) => s.phase)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'ready']))
    expect(readdirSync(join(dir, 'updates'))).toEqual(['Slinger-0.20.0-linux-amd64.deb'])
  })

  it('deb: installs with pkexec dpkg -i, then restarts after quitting', async () => {
    const u = make()
    u.download()
    await settled(u)
    let staged: { path: string; dirMode: number; bytes: Buffer } | null = null
    stagedCheck = (path) => {
      staged = { path, dirMode: statSync(dirname(path)).mode & 0o777, bytes: readFileSync(path) }
    }
    await u.install()
    // Installed from a verified copy in a fresh private directory, not from the user-writable updates folder.
    expect(spawned[0]).toMatchObject({ command: 'pkexec', args: ['dpkg', '-i', expect.stringMatching(/slinger-update-.*Slinger-0\.20\.0-linux-amd64\.deb$/)] })
    expect(staged!.path).toBe(spawned[0]!.args[2])
    expect(dirname(dirname(staged!.path))).toBe(join(dir, 'staging'))
    if (process.platform !== 'win32') expect(staged!.dirMode).toBe(0o700)
    expect(staged!.bytes.equals(payload)).toBe(true)
    expect(readdirSync(join(dir, 'staging'))).toEqual([]) // removed after dpkg
    expect(spawned[1]!.command).toBe('/bin/sh')
    expect(spawned[1]!.args[1]).toContain('while kill -0 4242')
    expect(spawned[1]!.args.at(-1)).toBe('/opt/Slinger/slinger')
    expect(spawned[1]!.detached).toBe(true)
    expect(quit).toHaveBeenCalledOnce()
  })

  it('deb: no password given is a clear error, and Slinger keeps running', async () => {
    const u = make()
    u.download()
    await settled(u)
    exitCode = 126
    await expect(u.install()).rejects.toMatchObject({ code: 'io_error' })
    expect(u.state()).toMatchObject({ phase: 'error', error: expect.stringContaining('password was not given') })
    expect(quit).not.toHaveBeenCalled()
  })

  it('AppImage: replaces the file in place (executable) and restarts it', async () => {
    const appImage = join(dir, 'Slinger.AppImage')
    writeFileSync(appImage, 'old')
    release = asRelease('0.20.0', 'Slinger-0.20.0-linux-x86_64.AppImage')
    const u = make({ method: 'appimage', reason: null, target: appImage })
    u.download()
    await settled(u)
    await u.install()
    expect(readFileSync(appImage).equals(payload)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(appImage).mode & 0o111).toBeTruthy()
    expect(spawned[0]!.args.at(-1)).toBe(appImage)
    expect(quit).toHaveBeenCalledOnce()
  })

  it('Windows: runs the installer silently, detached, and quits', async () => {
    release = asRelease('0.20.0', 'Slinger-0.20.0-win-x64.exe')
    const u = make({ method: 'nsis', reason: null, target: null })
    u.download()
    await settled(u)
    await u.install()
    expect(spawned).toEqual([{ command: join(dir, 'updates', 'Slinger-0.20.0-win-x64.exe'), args: ['/S', '--updated', '--force-run'], detached: true }])
    expect(quit).toHaveBeenCalledOnce()
  })

  it('re-verifies the installer right before installing: a file changed after the download is not installed', async () => {
    const cases: Array<[InstallTarget, string]> = [
      [{ method: 'deb', reason: null, target: null }, 'Slinger-0.20.0-linux-amd64.deb'],
      [{ method: 'nsis', reason: null, target: null }, 'Slinger-0.20.0-win-x64.exe'],
      [{ method: 'appimage', reason: null, target: join(dir, 'Slinger.AppImage') }, 'Slinger-0.20.0-linux-x86_64.AppImage'],
    ]
    writeFileSync(join(dir, 'Slinger.AppImage'), 'old')
    for (const [install, name] of cases) {
      release = asRelease('0.20.0', name)
      const u = make(install)
      u.download()
      await settled(u)
      expect(u.state().phase).toBe('ready')
      // Same size, different bytes (a swapped installer).
      writeFileSync(join(dir, 'updates', name), Buffer.alloc(payload.length, 9))
      await expect(u.install()).rejects.toMatchObject({ code: 'io_error', message: expect.stringContaining('changed after it was verified') })
      expect(u.state()).toMatchObject({ phase: 'error' })
    }
    expect(spawned).toEqual([])
    expect(quit).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'Slinger.AppImage'), 'utf8')).toBe('old')
    expect(readdirSync(dir)).not.toContain('Slinger.AppImage.new')
    expect(readdirSync(join(dir, 'staging'))).toEqual([])
  })

  it('deb: a staged copy that differs from the verified download is refused', async () => {
    const u = make()
    u.download()
    await settled(u)
    // Truncated file: the size check fails before hashing.
    writeFileSync(join(dir, 'updates', 'Slinger-0.20.0-linux-amd64.deb'), 'short')
    await expect(u.install()).rejects.toThrow('changed after it was verified')
    expect(spawned).toEqual([])
  })

  it('refuses a download that does not match the checksum, or is larger than said', async () => {
    release = asRelease('0.20.0', 'Slinger-0.20.0-linux-amd64.deb', { digest: `sha256:${'0'.repeat(64)}` })
    const u = make()
    u.download()
    await settled(u)
    expect(u.state()).toMatchObject({ phase: 'error', error: expect.stringContaining('checksum') })
    expect(readdirSync(join(dir, 'updates'))).toEqual([])
    await expect(u.install()).rejects.toThrow('No downloaded update')

    release = asRelease('0.20.0', 'Slinger-0.20.0-linux-amd64.deb', { size: 10 })
    u.download()
    await settled(u)
    expect(u.state().error).toContain('larger than GitHub said')
  })

  it('refuses without a checksum, a missing asset, a foreign URL, or no newer version', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [asRelease('0.20.0', 'Slinger-0.20.0-linux-amd64.deb', { digest: undefined }), 'no checksum'],
      [asRelease('0.20.0', 'Slinger-0.20.0-win-x64.exe'), 'has no Slinger-0.20.0-linux-amd64.deb'],
      [asRelease('0.20.0', 'Slinger-0.20.0-linux-amd64.deb', { browser_download_url: 'https://evil.example/x.deb' }), 'Refusing to download'],
      [asRelease('0.19.0', 'Slinger-0.19.0-linux-amd64.deb'), 'already the latest'],
    ]
    for (const [r, message] of cases) {
      release = r
      const u = make()
      u.download()
      await settled(u)
      expect(u.state().error, message).toContain(message)
    }
  })

  it('cancel stops the download and leaves nothing behind', async () => {
    slowMs = 2000
    const u = make()
    u.download()
    await expect.poll(() => u.state().received).toBeGreaterThan(0)
    u.cancel()
    await expect.poll(() => u.state().phase).toBe('idle')
    expect(existsSync(join(dir, 'updates', 'Slinger-0.20.0-linux-amd64.deb'))).toBe(false)
  })

  it('an installation that cannot update itself refuses to download, with the reason', () => {
    const u = make({ method: null, reason: 'This is a development build.', target: null })
    expect(u.state()).toMatchObject({ method: null, unsupportedReason: 'This is a development build.' })
    expect(() => u.download()).toThrow('development build')
  })
})
