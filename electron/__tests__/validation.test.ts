import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS, type SlingerIpcApi } from '../../shared/ipc-contract'
import { isUuid, assertUuid, newId } from '../lib/ids'
import { sanitizeFileName } from '../services/exportFiles'
import { makeEnv, NIL_UUID, scaffold, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

describe('API surface', () => {
  it('implements exactly the channels in IPC_CHANNELS', () => {
    expect(Object.keys(env.api).sort()).toEqual([...IPC_CHANNELS].sort())
  })
})

describe('UUID validation', () => {
  it('accepts v4/v7 and rejects everything else', () => {
    expect(isUuid(newId())).toBe(true)
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    for (const bad of ['', 'abc', '../../etc/passwd', '550e8400-e29b-41d4-a716-44665544000', `${newId()}/../x`, `${newId()}\n`, 42, null, undefined]) {
      expect(isUuid(bad), String(bad)).toBe(false)
    }
    const id = newId()
    expect(assertUuid(id.toUpperCase())).toBe(id)
  })

  it('every id-taking API method rejects a non-UUID with invalid_input before touching the database', async () => {
    const bad = '../../etc/passwd'
    const calls: Array<[keyof SlingerIpcApi, unknown[]]> = [
      ['renameWorkspace', [bad, 'x']],
      ['deleteWorkspace', [bad]],
      ['listEnvironments', [bad]],
      ['ensureDefaultEnvironment', [bad]],
      ['createEnvironment', [bad, 'x']],
      ['renameEnvironment', [bad, 'x']],
      ['deleteEnvironment', [bad]],
      ['listEnvironmentVariables', [bad]],
      ['deleteEnvironmentVariable', [bad]],
      ['revealEnvironmentVariable', [bad]],
      ['listCollections', [bad]],
      ['createCollection', [bad, 'x']],
      ['renameCollection', [bad, 'x']],
      ['deleteCollection', [bad]],
      ['listFolders', [bad]],
      ['renameFolder', [bad, 'x']],
      ['deleteFolder', [bad]],
      ['listRequests', [bad]],
      ['renameRequest', [bad, 'x']],
      ['deleteRequest', [bad]],
      ['listHistory', [bad]],
      ['clearHistory', [bad]],
      ['deleteHistoryEntry', [bad]],
      ['importPostmanCollection', [bad, '{}']],
      ['listCollectionVersions', [bad]],
      ['getCollectionVersion', [bad]],
      ['restoreCollectionVersion', [bad, 'copy']],
      ['deleteCollectionVersion', [bad]],
      ['createFolder', [{ workspaceId: bad, collectionId: newId(), name: 'x' }]],
      ['moveFolder', [{ folderId: bad, targetParentFolderId: null, targetIndex: 0 }]],
      ['moveRequest', [{ requestId: newId(), targetCollectionId: bad, targetFolderId: null, targetIndex: 0 }]],
      ['createCollectionVersion', [{ collectionId: bad, version: '1.0.0' }]],
    ]
    for (const [method, args] of calls) {
      await expect((env.api[method] as (...a: unknown[]) => Promise<unknown>)(...args), method).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('unknown but well-formed ids report not_found', async () => {
    await expect(env.api.deleteCollection(NIL_UUID.replace('0000', 'abcd'))).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('zod input validation at the IPC boundary', () => {
  it('rejects wrong types, missing/extra positional arguments and out-of-range values', async () => {
    const call = (m: string, ...a: unknown[]) => (env.api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a)
    await expect(call('createWorkspace', 42)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('createWorkspace')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('createWorkspace', 'a', 'b')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('createWorkspace', '   ')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('listHistory', newId(), 0)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('listHistory', newId(), 100000)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('executeHttpRequest', { method: 'GET' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call('moveFolder', { folderId: newId(), targetParentFolderId: null, targetIndex: -1 })).rejects.toMatchObject({ code: 'invalid_input' })
    const err = (await call('createWorkspace', 42).catch((e: unknown) => e)) as { details: { issues: unknown[] } }
    expect(err.details.issues.length).toBeGreaterThan(0)
  })

  it('validation errors never expose stack traces', async () => {
    const err = (await (env.api.createWorkspace as (...a: unknown[]) => Promise<unknown>)(1).catch((e: unknown) => e)) as { message: string; details: unknown }
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toMatch(/\.ts:\d+/)
  })
})

describe('export files', () => {
  it('sanitizes to a plain basename', () => {
    expect(sanitizeFileName('collection.json')).toBe('collection.json')
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('..\\..\\Windows\\evil.json')).toBe('evil.json')
    expect(sanitizeFileName('/abs/path/file.json')).toBe('file.json')
    expect(sanitizeFileName('a<b>:c|d?.json')).toBe('a_b__c_d_.json')
    expect(sanitizeFileName('  spaced.json  ')).toBe('spaced.json')
    expect(sanitizeFileName('bad\u0000name\n.json')).toBe('badname.json')
    for (const bad of ['', '   ', '.', '..', '...', 'dir/', 'a/..', 'CON', 'nul.txt', 42, null]) {
      expect(() => sanitizeFileName(bad), String(bad)).toThrow()
    }
  })

  it('defaultExportPath and writeExportFile stay inside the export directory', async () => {
    const path = await env.api.defaultExportPath('../../../tmp/evil.json')
    expect(path).toBe(join(env.exportDir, 'evil.json'))
    await env.api.writeExportFile('../../escape.json', '{"a":1}')
    expect(readFileSync(join(env.exportDir, 'escape.json'), 'utf8')).toBe('{"a":1}')
    expect(existsSync(join(env.exportDir, '..', '..', 'escape.json'))).toBe(false)
    await env.api.writeExportFile('nested/dir/file.json', 'x')
    expect(existsSync(join(env.exportDir, 'file.json'))).toBe(true)
    expect(existsSync(join(env.exportDir, 'nested'))).toBe(false)
  })

  it('refuses to write through a symlink or over a directory', async () => {
    const outside = join(env.exportDir, 'outside-target.txt')
    writeFileSync(outside, 'original')
    symlinkSync(outside, join(env.exportDir, 'link.json'))
    await expect(env.api.writeExportFile('link.json', 'pwned')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(readFileSync(outside, 'utf8')).toBe('original')
    mkdirSync(join(env.exportDir, 'adir'))
    await expect(env.api.writeExportFile('adir', 'x')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('chooseExportDirectory switches the export directory', async () => {
    expect(await env.api.chooseExportDirectory()).toBe(env.exportDir)
  })
})

describe('openExternalUrl', () => {
  it('opens http/https only', async () => {
    await env.api.openExternalUrl('https://example.com/a?b=1')
    await env.api.openExternalUrl('http://localhost:3000')
    expect(env.opened).toEqual(['https://example.com/a?b=1', 'http://localhost:3000/'])
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.com', 'data:text/html,hi', 'mailto:a@b.c', 'app://slinger/x', 'not a url', '', '   ']) {
      await expect(env.api.openExternalUrl(bad), bad).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(env.opened.length).toBe(2)
  })
})

describe('history CRUD', () => {
  it('lists newest first, honours limit, deletes one entry, clears all', async () => {
    const { workspace } = await scaffold(env)
    for (let i = 0; i < 3; i++) {
      env.core.history.record({ workspaceId: workspace.id, requestId: null, requestName: `r${i}`, method: 'GET', url: `http://x/${i}`, statusCode: 200, ok: true, errorMessage: null, durationMs: 1 })
    }
    const all = await env.api.listHistory(workspace.id)
    expect(all.map((h) => h.requestName)).toEqual(['r2', 'r1', 'r0'])
    expect((await env.api.listHistory(workspace.id, 2)).length).toBe(2)
    await env.api.deleteHistoryEntry(all[0]!.id)
    await env.api.deleteHistoryEntry(all[0]!.id) // idempotent
    expect((await env.api.listHistory(workspace.id)).length).toBe(2)
    await env.api.clearHistory(workspace.id)
    expect(await env.api.listHistory(workspace.id)).toEqual([])
  })
})
