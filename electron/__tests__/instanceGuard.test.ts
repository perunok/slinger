import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireInstanceGuard, instanceGuardPath, type InstanceGuard } from '../lib/instanceGuard'

const posix = process.platform !== 'win32'
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

async function acquire(onShow = vi.fn()) {
  const g = await acquireInstanceGuard(path, onShow)
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
    const g = await acquireInstanceGuard(posix ? join(dir, 'missing-dir', 'x.sock') : '\\\\.\\pipe\\', vi.fn())
    expect(g.primary).toBe(true)
  })

  it('paths: private runtime folder per user on Linux, tmp on macOS, a named pipe on Windows', () => {
    expect(instanceGuardPath({ platform: 'linux', uid: 1000, username: 'ann', runtimeDir: '/run/user/1000', tmpDir: '/tmp' })).toBe('/run/user/1000/slinger-1000.sock')
    expect(instanceGuardPath({ platform: 'linux', uid: 1000, username: 'ann', tmpDir: '/tmp' })).toBe('/tmp/slinger-1000.sock')
    expect(instanceGuardPath({ platform: 'darwin', uid: 501, username: 'ann', tmpDir: '/var/folders/x/T' })).toBe('/var/folders/x/T/slinger-501.sock')
    expect(instanceGuardPath({ platform: 'win32', username: 'Ann Lee', tmpDir: 'C:\\Temp' })).toBe('\\\\.\\pipe\\slinger-Ann_Lee')
  })
})
