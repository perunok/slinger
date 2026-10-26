import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireInstanceGuard, ensurePrivateDir, guardSecret, instanceGuardPath, socketOwnership, type InstanceGuard } from '../lib/instanceGuard'

const posix = process.platform !== 'win32'
const uid = process.getuid?.() ?? 0
let dir: string
let path: string
const held: InstanceGuard[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slinger-guard-'))
  path = posix ? join(dir, 'slinger-test.sock') : `\\\\.\\pipe\\slinger-test-${process.pid}-${Date.now()}`
})
afterEach(() => {
  for (const g of held.splice(0)) if (g.primary) g.close()
  rmSync(dir, { recursive: true, force: true })
})

async function acquire(onShow = vi.fn(), asUid?: number) {
  const g = await acquireInstanceGuard(path, onShow, process.platform, asUid ?? process.getuid?.())
  held.push(g)
  return g
}

describe('instance guard (one Slinger per user)', () => {
  it('the first start takes it; a second one asks the first to show its window and does not', async () => {
    const show = vi.fn()
    expect((await acquire(show)).primary).toBe(true)
    expect((await acquire()).primary).toBe(false)
    expect(show).toHaveBeenCalledTimes(1)
    expect((await acquire()).primary).toBe(false)
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('after the first quits, the next start takes it', async () => {
    const first = await acquire()
    if (first.primary) first.close()
    held.length = 0
    expect((await acquire()).primary).toBe(true)
  })

  it.runIf(posix)('a socket file left by a crash (nobody listening) is replaced', async () => {
    writeFileSync(path, '')
    expect((await acquire()).primary).toBe(true)
  })

  it('a first Slinger that is slow to answer still counts as running', async () => {
    // Something listens but never answers: the second start must not take over.
    const sockets: Socket[] = []
    const silent = createServer((s) => void sockets.push(s))
    await new Promise<void>((r) => silent.listen(path, r))
    try {
      const t0 = Date.now()
      expect((await acquire()).primary).toBe(false)
      expect(Date.now() - t0).toBeLessThan(5000)
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise((r) => silent.close(r))
    }
  })

  it('a lock that cannot be created never blocks starting', async () => {
    const g = await acquireInstanceGuard(posix ? join(dir, 'missing', 'missing-dir', 'x.sock') : '\\\\.\\pipe\\', vi.fn())
    expect(g.primary).toBe(true)
  })

  it('paths: a private folder per user (runtime folder on Linux, tmp otherwise), an unguessable named pipe on Windows', () => {
    expect(instanceGuardPath({ platform: 'linux', uid: 1000, username: 'ann', runtimeDir: '/run/user/1000', tmpDir: '/tmp' })).toBe('/run/user/1000/slinger-1000/instance.sock')
    expect(instanceGuardPath({ platform: 'linux', uid: 1000, username: 'ann', tmpDir: '/tmp' })).toBe('/tmp/slinger-1000/instance.sock')
    expect(instanceGuardPath({ platform: 'darwin', uid: 501, username: 'ann', tmpDir: '/var/folders/x/T' })).toBe('/var/folders/x/T/slinger-501/instance.sock')
    const pipe = instanceGuardPath({ platform: 'win32', username: 'Ann Lee', tmpDir: 'C:\\Temp', secret: 'a'.repeat(64) })
    expect(pipe).toMatch(/^\\\\\.\\pipe\\slinger-[0-9a-f]{32}$/)
    expect(pipe).not.toContain('Ann')
    expect(instanceGuardPath({ platform: 'win32', username: 'Ann Lee', tmpDir: 'C:\\Temp', secret: 'b'.repeat(64) })).not.toBe(pipe)
  })

  it('the Windows pipe secret is random, kept and reused', () => {
    const file = join(dir, 'Slinger', 'instance-guard.key')
    const a = guardSecret(file)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(guardSecret(file)).toBe(a)
    expect(readFileSync(file, 'utf8')).toBe(a)
    if (posix) expect(statSync(file).mode & 0o077).toBe(0)
  })
})

describe.runIf(posix)('instance guard: another user cannot squat the lock (POSIX)', () => {
  it('creates the lock folder private (0700) and tightens our own folder that is too open', () => {
    const d = join(dir, 'slinger-1000')
    expect(ensurePrivateDir(d, uid)).toBe(true)
    expect(statSync(d).mode & 0o777).toBe(0o700)
    chmodSync(d, 0o777)
    expect(ensurePrivateDir(d, uid)).toBe(true)
    expect(statSync(d).mode & 0o777).toBe(0o700)
  })

  it('refuses a lock folder of another user, a symlink or a file', () => {
    const d = join(dir, 'owned')
    mkdirSync(d)
    expect(ensurePrivateDir(d, uid + 1)).toBe(false)
    symlinkSync(d, join(dir, 'link'))
    expect(ensurePrivateDir(join(dir, 'link'), uid)).toBe(false)
    writeFileSync(join(dir, 'file'), '')
    expect(ensurePrivateDir(join(dir, 'file'), uid)).toBe(false)
  })

  it('socket ownership: ours, someone else\'s (or not a socket), missing', async () => {
    expect(socketOwnership(path, uid)).toBe('missing')
    writeFileSync(path, '')
    expect(socketOwnership(path, uid)).toBe('foreign') // a plain file is not a socket
    rmSync(path)
    const g = await acquire()
    expect(g.primary).toBe(true)
    expect(socketOwnership(path, uid)).toBe('ours')
    expect(socketOwnership(path, uid + 1)).toBe('foreign')
  })

  it('a socket owned by another user does not make Slinger exit, and is left alone', async () => {
    const show = vi.fn()
    // A Slinger holds the lock; seen as another user (uid + 1), its socket and folder are not "ours".
    expect((await acquire(show)).primary).toBe(true)
    const g = await acquire(vi.fn(), uid + 1)
    expect(g.primary).toBe(true) // starts (without the guard) instead of quitting
    expect(show).not.toHaveBeenCalled() // and never talked to it
    expect(socketOwnership(path, uid)).toBe('ours') // nor removed it
  })

  it('a socket of ours that answers something other than the protocol is not a Slinger', async () => {
    const sockets: Socket[] = []
    const liar = createServer((s) => {
      sockets.push(s)
      s.write('nope\n')
    })
    await new Promise<void>((r) => liar.listen(path, r))
    try {
      const t0 = Date.now()
      expect((await acquire()).primary).toBe(true)
      expect(Date.now() - t0).toBeLessThan(1500) // decided on the answer, not by waiting for the timeout
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise((r) => liar.close(r))
    }
  })
})
