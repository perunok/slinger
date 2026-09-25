import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import { migrateLegacyDataDir } from '../lib/legacyDataDir'
import { baseHttp, makeEnv, pickAndGrant, scaffold, startTestServer, type TestEnv } from './helpers'

let env: TestEnv
let server: Awaited<ReturnType<typeof startTestServer>>
let wsId: string
let dir: string
let secret: string
let allowed: string

beforeAll(async () => {
  server = await startTestServer()
  dir = mkdtempSync(join(tmpdir(), 'slinger-grants-'))
  secret = join(dir, 'secret.txt')
  allowed = join(dir, 'allowed.txt')
  writeFileSync(secret, 'TOP-SECRET')
  writeFileSync(allowed, 'ALLOWED')
})
afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
  server.requests.length = 0
})
afterEach(() => env.cleanup())

const sendForm = (filePath: string) =>
  env.api.executeHttpRequest(
    baseHttp(wsId, {
      method: 'POST',
      url: `${server.baseUrl}/echo`,
      body: { mode: 'formData', formData: [{ key: 'f', value: '', filePath, type: 'file', enabled: true }] },
    } as Partial<HttpRequestInput> & { url: string }),
  )
const sendBinary = (binaryFilePath: string) =>
  env.api.executeHttpRequest(baseHttp(wsId, { method: 'PUT', url: `${server.baseUrl}/echo`, body: { mode: 'binary', binaryFilePath } }))

describe('local file access is limited to files chosen with pickFile', () => {
  it('rejects a file that was never granted, without sending anything', async () => {
    await expect(sendForm(secret)).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'file_not_granted' } })
    await expect(sendBinary(secret)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(server.requests).toHaveLength(0)
  })

  it('allows a granted file, and a grant covers only that file', async () => {
    await pickAndGrant(env, allowed)
    await expect(sendBinary(allowed)).resolves.toMatchObject({ status: 200 })
    expect(server.last().body.toString()).toBe('ALLOWED')
    await expect(sendBinary(secret)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a cancelled dialog grants nothing', async () => {
    env.picked.result = null
    expect(await env.api.pickFile()).toBeNull()
    await expect(sendBinary(allowed)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects .. traversal out of a granted location', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const inSub = join(dir, 'sub', 'ok.txt')
    writeFileSync(inSub, 'sub')
    await pickAndGrant(env, inSub)
    await expect(sendBinary(join(dir, 'sub', '..', 'secret.txt'))).rejects.toMatchObject({ code: 'invalid_input' })
    // A non-canonical spelling of the granted file itself is still the same file.
    await expect(sendBinary(join(dir, 'sub', '..', 'sub', 'ok.txt'))).resolves.toMatchObject({ status: 200 })
  })

  it('rejects a symlink to an ungranted file, even when the link sits next to a granted one', async () => {
    await pickAndGrant(env, allowed)
    const link = join(dir, 'link-to-secret.txt')
    rmSync(link, { force: true })
    symlinkSync(secret, link)
    await expect(sendBinary(link)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(server.requests).toHaveLength(0)
  })

  it('a granted file swapped for a symlink afterwards is refused', async () => {
    const victim = join(dir, 'swap.txt')
    writeFileSync(victim, 'first')
    await pickAndGrant(env, victim)
    await expect(sendBinary(victim)).resolves.toMatchObject({ status: 200 })
    rmSync(victim)
    symlinkSync(secret, victim)
    await expect(sendBinary(victim)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a granted symlink resolves to its target: grant is by real path', async () => {
    const link = join(dir, 'link-to-allowed.txt')
    rmSync(link, { force: true })
    symlinkSync(allowed, link)
    await pickAndGrant(env, link) // user picked the link; the real file is what gets granted
    await expect(sendBinary(allowed)).resolves.toMatchObject({ status: 200 })
    await expect(sendBinary(secret)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('grants do not survive a new app session (fresh Core)', async () => {
    await pickAndGrant(env, allowed)
    const other = makeEnv()
    try {
      const ws = (await scaffold(other)).workspace.id
      await expect(
        other.api.executeHttpRequest(baseHttp(ws, { method: 'PUT', url: `${server.baseUrl}/echo`, body: { mode: 'binary', binaryFilePath: allowed } })),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      other.cleanup()
    }
  })

  it('grantedFiles reports which saved paths are currently granted', async () => {
    await pickAndGrant(env, allowed)
    expect(await env.api.grantedFiles([allowed, secret, join(dir, 'nope')])).toEqual([allowed])
  })

  it('refuses to grant a directory or a missing path returned by a dialog', async () => {
    await expect(pickAndGrant(env, dir)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(pickAndGrant(env, join(dir, 'nope'))).rejects.toBeDefined()
  })
})

describe('writeExportFile stays inside the export directory', () => {
  it('ignores any directory part of the name', async () => {
    await env.api.writeExportFile('../../escape.txt', 'x')
    await env.api.writeExportFile('/etc/evil.txt', 'x')
    expect(readFileSync(join(env.exportDir, 'escape.txt'), 'utf8')).toBe('x')
    expect(readFileSync(join(env.exportDir, 'evil.txt'), 'utf8')).toBe('x')
  })
  it('refuses to write through a symlink planted in the export directory', async () => {
    const target = join(dir, 'export-victim.txt')
    writeFileSync(target, 'untouched')
    symlinkSync(target, join(env.exportDir, 'planted.txt'))
    await expect(env.api.writeExportFile('planted.txt', 'overwritten')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })
  it('the export directory only changes through the native folder dialog', async () => {
    expect(env.core.exportFiles.exportDirectory).toBe(env.exportDir)
    expect(Object.keys(env.api)).not.toContain('setExportDirectory')
  })
})

describe('cloudFetch', () => {
  it('reaches the network but never records history and never reads files', async () => {
    const before = await env.api.listHistory(wsId)
    const res = await env.api.cloudFetch({
      method: 'POST',
      url: `${server.baseUrl}/v1/x`,
      headers: [{ key: 'Accept', value: 'application/json' }],
      body: { content: '{"a":1}', contentType: 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(server.last()).toMatchObject({ method: 'POST', url: '/v1/x' })
    expect(server.last().body.toString()).toBe('{"a":1}')
    expect(await env.api.listHistory(wsId)).toEqual(before)
  })
  it('records history for executeHttpRequest, unlike cloudFetch (control)', async () => {
    await env.api.executeHttpRequest(baseHttp(wsId, { url: `${server.baseUrl}/echo` }))
    expect(await env.api.listHistory(wsId)).toHaveLength(1)
  })
  it('does not record failures either, and rejects unknown/file fields', async () => {
    await expect(env.api.cloudFetch({ method: 'GET', url: 'ftp://x', headers: [] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      env.api.cloudFetch({ method: 'GET', url: server.baseUrl, headers: [], body: { binaryFilePath: secret } } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await env.api.listHistory(wsId)).toHaveLength(0)
  })
})

describe('migrateLegacyDataDir', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'slinger-mig-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  const mk = (name: string, db?: string) => {
    const d = join(base, name)
    mkdirSync(d, { recursive: true })
    if (db !== undefined) writeFileSync(join(d, 'slinger.db'), db)
    return d
  }

  it('moves the old dev profile when the new location does not exist', () => {
    const legacy = mk('slinger', 'old')
    const target = join(base, 'Slinger')
    expect(migrateLegacyDataDir(legacy, target)).toBe('moved')
    expect(readFileSync(join(target, 'slinger.db'), 'utf8')).toBe('old')
  })
  it('copies into an existing empty target without overwriting', () => {
    const legacy = mk('slinger', 'old')
    writeFileSync(join(legacy, 'extra.txt'), 'e')
    const target = mk('Slinger')
    expect(migrateLegacyDataDir(legacy, target)).toBe('copied')
    expect(readFileSync(join(target, 'slinger.db'), 'utf8')).toBe('old')
  })
  it('never touches a target that already has a database', () => {
    const legacy = mk('slinger', 'old')
    const target = mk('Slinger', 'new')
    expect(migrateLegacyDataDir(legacy, target)).toBe('none')
    expect(readFileSync(join(target, 'slinger.db'), 'utf8')).toBe('new')
  })
  it('does nothing without a legacy database or when both names are the same directory', () => {
    expect(migrateLegacyDataDir(join(base, 'missing'), join(base, 'Slinger'))).toBe('none')
    const same = mk('slinger', 'x')
    expect(migrateLegacyDataDir(same, same)).toBe('none')
    const link = join(base, 'alias')
    symlinkSync(same, link)
    expect(migrateLegacyDataDir(same, link)).toBe('none')
  })
})
