import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeEnv, type TestEnv } from './helpers'
import { contentSecurityPolicy } from '../lib/csp'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

describe('writeExportFile encoding', () => {
  it('defaults to utf8', async () => {
    await env.api.writeExportFile('a.txt', 'héllo')
    expect(readFileSync(join(env.exportDir, 'a.txt'), 'utf8')).toBe('héllo')
  })

  it('writes raw bytes for base64', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 255, 0x25, 0x50, 0x44, 0x46])
    await env.api.writeExportFile('b.bin', bytes.toString('base64'), 'base64')
    expect(readFileSync(join(env.exportDir, 'b.bin')).equals(bytes)).toBe(true)
  })

  it('writes an empty base64 payload as an empty file', async () => {
    await env.api.writeExportFile('empty.bin', '', 'base64')
    expect(readFileSync(join(env.exportDir, 'empty.bin')).length).toBe(0)
  })

  it('rejects malformed base64 without creating the file', async () => {
    await expect(env.api.writeExportFile('bad.bin', 'not base64!!', 'base64')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.writeExportFile('bad.bin', 'abc', 'base64')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(() => readFileSync(join(env.exportDir, 'bad.bin'))).toThrow()
  })

  it('rejects an unknown encoding', async () => {
    await expect(env.api.writeExportFile('c.txt', 'x', 'latin1' as never)).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('pickFile', () => {
  it('returns the dialog result and passes validated options through', async () => {
    env.picked.result = '/tmp/some/file.png'
    const options = { title: 'Choose', filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] }
    expect(await env.api.pickFile(options)).toBe('/tmp/some/file.png')
    expect(env.picked.calls).toEqual([options])
  })

  it('works without options and returns null when cancelled', async () => {
    env.picked.result = null
    expect(await env.api.pickFile()).toBeNull()
    expect(env.picked.calls).toEqual([{}])
  })

  it('rejects invalid options', async () => {
    await expect(env.api.pickFile({ title: 5 } as never)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.pickFile({ filters: [{ name: 'x', extensions: ['../evil/*'] }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.pickFile({ filters: 'x' } as never)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(env.picked.calls).toEqual([])
  })
})

describe('content security policy', () => {
  const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(name + ' '))

  it('allows blob: frames (PDF preview) and nothing else in frame-src', () => {
    const csp = contentSecurityPolicy({ dev: false })
    expect(directive(csp, 'frame-src')).toBe("frame-src blob:")
  })

  it('keeps scripts, connections and objects locked down', () => {
    const csp = contentSecurityPolicy({ dev: false })
    expect(directive(csp, 'default-src')).toBe("default-src 'none'")
    expect(directive(csp, 'script-src')).toBe("script-src 'self'")
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'")
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'")
  })
})

describe('permissions', () => {
  const trusted = (url: string) => url.startsWith('app://slinger/')
  it('allows only clipboard writes, only from the app origin', async () => {
    const { isPermissionAllowed } = await import('../lib/permissions')
    expect(isPermissionAllowed('clipboard-sanitized-write', 'app://slinger/index.html', trusted)).toBe(true)
    expect(isPermissionAllowed('clipboard-sanitized-write', 'https://evil.example/', trusted)).toBe(false)
    for (const p of ['clipboard-read', 'media', 'geolocation', 'notifications', 'openExternal']) {
      expect(isPermissionAllowed(p, 'app://slinger/index.html', trusted), p).toBe(false)
    }
  })
})
