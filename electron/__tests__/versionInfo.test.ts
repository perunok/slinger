import { hostname, userInfo } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectVersionInfo } from '../lib/versionInfo'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

describe('getVersionInfo', () => {
  it('returns the app and runtime versions plus OS platform/release/arch, and nothing else', async () => {
    const info = await env.api.getVersionInfo()
    expect(Object.keys(info).sort()).toEqual(['app', 'chrome', 'electron', 'node', 'os', 'v8'])
    expect(Object.keys(info.os).sort()).toEqual(['arch', 'platform', 'release'])
    expect(info.app).toBe('0.0.0-test')
    expect(info.node).toBe(process.versions.node)
    expect(info.v8).toBe(process.versions.v8)
    expect(info.electron).toBeNull() // plain Node under vitest
    expect(info.os.platform).toBe(process.platform)
    expect(info.os.arch).toBe(process.arch)
    // No identifying data: host name, user name, home directory, environment.
    const text = JSON.stringify(info)
    for (const secret of [hostname(), userInfo().username, userInfo().homedir, process.cwd()].filter((s) => s.length > 2)) {
      expect(text).not.toContain(secret)
    }
  })

  it('rejects arguments and drops values that are not plain version tokens', async () => {
    await expect((env.api.getVersionInfo as (...a: unknown[]) => Promise<unknown>)('x')).rejects.toMatchObject({ code: 'invalid_input' })
    const info = collectVersionInfo('1.2.3', { electron: '33.4.11', chrome: 'bad value /home/me', node: undefined, v8: '12.9.202.28-electron.0' }, { platform: 'linux', release: '6.8.0-45-generic', arch: 'x64' })
    expect(info).toEqual({ app: '1.2.3', electron: '33.4.11', chrome: null, node: null, v8: '12.9.202.28-electron.0', os: { platform: 'linux', release: '6.8.0-45-generic', arch: 'x64' } })
  })
})
