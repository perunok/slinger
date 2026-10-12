/**
 * One Slinger per user: a second Slinger started with ANOTHER profile (which Electron's per-profile lock allows) finds the
 * per-user lock taken (SLINGER_INSTANCE_GUARD turns it on for unpackaged test builds), asks the first to show its window and
 * exits before opening its own database. The first keeps running.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, ROOT, type Launched } from './support/app'

const electronBinary = createRequire(import.meta.url)('electron') as unknown as string
let tmp: string
let guard: string
let ctx: Launched

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'slinger-e2e-single-'))
  guard = process.platform === 'win32' ? `\\\\.\\pipe\\slinger-e2e-${process.pid}` : join(tmp, 'guard.sock')
  ctx = await launch(join(tmp, 'first'), { SLINGER_INSTANCE_GUARD: guard })
}, 60_000)

afterAll(async () => {
  await ctx?.app.close().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
})

describe('single instance per user', () => {
  it('a second Slinger with another profile exits at once and leaves its profile untouched', async () => {
    const second = join(tmp, 'second')
    const env: Record<string, string> = { ...(process.env as Record<string, string>), SLINGER_USER_DATA_DIR: second, SLINGER_INSTANCE_GUARD: guard, SLINGER_HIDE_WINDOW: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const args = ['.', ...(process.env.CI || process.getuid?.() === 0 ? ['--no-sandbox'] : [])]
    const child = spawn(electronBinary, args, { cwd: ROOT, env, stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill()
        reject(new Error('the second Slinger kept running'))
      }, 20_000)
      child.on('exit', (c) => {
        clearTimeout(t)
        resolve(c)
      })
    })
    expect(code).toBe(0)
    expect(existsSync(join(second, 'slinger.db'))).toBe(false)
    // The first one is still there and working.
    expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await ctx.page.evaluate(() => window.slinger.listWorkspaces().then((w) => w.length))).toBeGreaterThan(0)
  })

  it('logged no page errors', () => {
    expect(ctx.problems).toEqual([])
  })
})
