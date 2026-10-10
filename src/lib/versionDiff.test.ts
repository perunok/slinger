import { describe, expect, it } from 'vitest'
import type { CollectionSnapshot } from '../../shared/types'
import { diffSnapshots, folderPath, snapshotFromCollection, type SnapshotRequest } from './versionDiff'

function r(id: string, name: string, folderId: string | null, doc: Record<string, unknown> = {}, extra: Partial<SnapshotRequest> = {}): SnapshotRequest {
  const method = (doc.method as string) ?? 'GET'
  const url = (doc.url as string) ?? `https://x/${id}`
  return { id, name, folderId, method, url, sortOrder: 0, documentJson: JSON.stringify({ name, method, url, ...doc }), ...extra }
}
const snap = (requests: SnapshotRequest[], folders: CollectionSnapshot['folders'] = []): CollectionSnapshot => ({
  collectionName: 'C', folders, requests,
})
const f = (id: string, parent: string | null, name: string) => ({ id, parentFolderId: parent, name, sortOrder: 0 })

describe('folderPath', () => {
  const folders = [f('a', null, 'A'), f('b', 'a', 'B')]
  it('joins names', () => {
    expect(folderPath(folders, 'b')).toBe('A/B')
    expect(folderPath(folders, null)).toBe('')
    expect(folderPath(folders, 'nope')).toBe('')
  })
  it('survives cycles', () => {
    expect(folderPath([f('x', 'y', 'X'), f('y', 'x', 'Y')], 'x')).toBe('Y/X')
  })
})

describe('snapshotFromCollection', () => {
  it('picks snapshot columns', () => {
    const s = snapshotFromCollection(
      { id: 'c', workspaceId: 'w', name: 'Coll', createdAt: 1, updatedAt: 1, version: 1 },
      [{ id: 'f', workspaceId: 'w', collectionId: 'c', parentFolderId: null, name: 'F', sortOrder: 2, createdAt: 1, updatedAt: 1, version: 1 }],
      [{ id: 'r', workspaceId: 'w', collectionId: 'c', folderId: 'f', name: 'R', method: 'GET', url: 'u', documentJson: '{}', sortOrder: 1, createdAt: 1, updatedAt: 1, version: 1 }],
    )
    expect(s).toEqual({
      collectionName: 'Coll',
      folders: [{ id: 'f', parentFolderId: null, name: 'F', sortOrder: 2 }],
      requests: [{ id: 'r', folderId: 'f', name: 'R', method: 'GET', url: 'u', documentJson: '{}', sortOrder: 1 }],
    })
  })
})

describe('diffSnapshots', () => {
  it('reports identical snapshots', () => {
    const s = snap([r('1', 'A', null)], [f('f', null, 'F')])
    const d = diffSnapshots(s, s)
    expect(d.identical).toBe(true)
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 1 })
  })

  it('finds added, removed and changed, ordered added/removed/changed by path', () => {
    const base = snap([r('1', 'Keep', null), r('2', 'Gone', null), r('3', 'Edit', null, { method: 'GET' })])
    const target = snap([r('1', 'Keep', null), r('3', 'Edit', null, { method: 'POST' }), r('9', 'Zed', null), r('8', 'Alpha', null)])
    const d = diffSnapshots(base, target)
    expect(d.requests.map((x) => [x.status, x.path])).toEqual([['added', 'Alpha'], ['added', 'Zed'], ['removed', 'Gone'], ['changed', 'Edit']])
    expect(d.summary).toEqual({ added: 2, removed: 1, changed: 1, unchanged: 1 })
    expect(d.requests[3].changes).toEqual([{ field: 'method', before: 'GET', after: 'POST' }])
    expect(d.requests[0].changes).toEqual([])
    expect(d.requests[2].before?.id).toBe('2')
    expect(d.identical).toBe(false)
  })

  it('reports name, url and folder changes with full paths', () => {
    const base = snap([r('1', 'Old', 'a', { url: 'https://x/1' })], [f('a', null, 'A'), f('b', 'a', 'B')])
    const target = snap([r('1', 'New', 'b', { url: 'https://x/2' })], [f('a', null, 'A'), f('b', 'a', 'B')])
    const d = diffSnapshots(base, target)
    expect(d.requests[0].path).toBe('A/B/New')
    const byField = Object.fromEntries(d.requests[0].changes.map((c) => [c.field, c]))
    expect(byField.name).toEqual({ field: 'name', before: 'Old', after: 'New' })
    expect(byField.url).toMatchObject({ before: 'https://x/1', after: 'https://x/2' })
    expect(byField.folder).toEqual({ field: 'folder', before: 'A', after: 'A/B' })
  })

  it('matches by path when ids differ (restore as copy)', () => {
    const u = { url: 'https://x/same' }
    const base = snap([r('1', 'Req', 'a', u), r('2', 'Req', 'a', u), r('3', 'Solo', null, u)], [f('a', null, 'A')])
    const target = snap([r('x', 'Req', 'fa', u), r('y', 'Req', 'fa', u), r('z', 'Solo', null, { ...u, method: 'PUT' })], [f('fa', null, 'A')])
    const d = diffSnapshots(base, target)
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 2 })
    expect(d.foldersAdded).toEqual([])
    expect(d.foldersRemoved).toEqual([])
    expect(d.requests[0]).toMatchObject({ key: '3', status: 'changed' })
  })

  it('detects header changes semantically (order, blank rows, disabled)', () => {
    const h1 = [{ key: 'A', value: '1' }, { key: 'B', value: '2' }]
    const sameHeaders = [{ key: 'B', value: '2', type: 'text' }, { key: '', value: '' }, { key: 'A', value: '1' }]
    const d0 = diffSnapshots(snap([r('1', 'x', null, { headers: h1 })]), snap([r('1', 'x', null, { headers: sameHeaders })]))
    expect(d0.identical).toBe(true)
    const d1 = diffSnapshots(snap([r('1', 'x', null, { headers: h1 })]), snap([r('1', 'x', null, { headers: [{ key: 'A', value: '1' }, { key: 'B', value: '2', disabled: true }] })]))
    expect(d1.requests[0].changes).toEqual([{ field: 'headers', before: 'A: 1\nB: 2', after: 'A: 1\n[off] B: 2' }])
  })

  it('compares bodies semantically', () => {
    const raw = (t: string, lang = 'json') => ({ body: { mode: 'raw', raw: t, options: { raw: { language: lang } } } })
    const d = diffSnapshots(snap([r('1', 'x', null, raw('{"a":1}'))]), snap([r('1', 'x', null, raw('{"a":2}'))]))
    expect(d.requests[0].changes).toEqual([{ field: 'body', before: 'raw (json)\n{"a":1}', after: 'raw (json)\n{"a":2}' }])
    const none = diffSnapshots(snap([r('1', 'x', null, { body: null })]), snap([r('1', 'x', null, { body: { mode: 'none' } })]))
    expect(none.identical).toBe(true)
    const form = (rows: unknown[]) => ({ body: { mode: 'formdata', formdata: rows } })
    const fd = diffSnapshots(
      snap([r('1', 'x', null, form([{ key: 'a', value: '1' }, { key: 'f', type: 'file', src: '/a' }]))]),
      snap([r('1', 'x', null, form([{ key: 'f', type: 'file', src: '/b' }, { key: 'a', value: '1' }]))]),
    )
    expect(fd.requests[0].changes[0].field).toBe('body')
    expect(fd.requests[0].changes[0].after).toContain('f: @file /b')
    const modeChange = diffSnapshots(snap([r('1', 'x', null, { body: null })]), snap([r('1', 'x', null, { body: { mode: 'file', file: { src: '/z' } } })]))
    expect(modeChange.requests[0].changes).toEqual([{ field: 'body', before: 'none', after: 'binary: /z' }])
  })

  it('compares auth', () => {
    const bearer = (t: string) => ({ auth: { type: 'bearer', bearer: [{ key: 'token', value: t, type: 'string' }] } })
    const d = diffSnapshots(snap([r('1', 'x', null, bearer('a'))]), snap([r('1', 'x', null, bearer('b'))]))
    expect(d.requests[0].changes).toEqual([{ field: 'auth', before: 'bearer\ntoken: a', after: 'bearer\ntoken: b' }])
    const off = diffSnapshots(snap([r('1', 'x', null, bearer('a'))]), snap([r('1', 'x', null, {})]))
    expect(off.requests[0].changes[0]).toMatchObject({ field: 'auth', after: 'none' })
  })

  it('compares disabled params and description; ignores source and responses noise', () => {
    const base = snap([r('1', 'x', null, { description: 'one', params: [{ key: 'd', value: '1', disabled: true }], responses: [{ a: 1 }], source: { junk: 1 } })])
    const target = snap([r('1', 'x', null, { description: 'two', params: [{ key: 'd', value: '2', disabled: true }], responses: [{ a: 2 }], source: { junk: 2 } })])
    const d = diffSnapshots(base, target)
    expect(d.requests[0].changes.map((c) => c.field)).toEqual(['params', 'description'])
    const noise = diffSnapshots(
      snap([r('1', 'x', null, { responses: [1], source: { a: 1 } })]),
      snap([r('1', 'x', null, { responses: [2], source: { a: 2 } })]),
    )
    expect(noise.identical).toBe(true)
  })

  it('reports script changes as other; ignores key order', () => {
    const sc = (a: string) => ({ scripts: [{ listen: 'test', script: { exec: [a], type: 'text/javascript' } }] })
    const d = diffSnapshots(snap([r('1', 'x', null, sc('a'))]), snap([r('1', 'x', null, sc('b'))]))
    expect(d.requests[0].changes.map((c) => c.field)).toEqual(['other'])
    const reordered = diffSnapshots(
      snap([r('1', 'x', null, { scripts: [{ listen: 'test', script: { type: 'text/javascript', exec: ['a'] } }] })]),
      snap([r('1', 'x', null, sc('a'))]),
    )
    expect(reordered.identical).toBe(true)
  })

  it('reports folder adds, removals and renames', () => {
    const base = snap([], [f('a', null, 'Old'), f('b', 'a', 'Child'), f('c', null, 'Removed')])
    const target = snap([], [f('a', null, 'New'), f('b', 'a', 'Child'), f('d', 'a', 'Added')])
    const d = diffSnapshots(base, target)
    expect(d.foldersRenamed).toEqual([{ before: 'Old', after: 'New' }])
    expect(d.foldersRemoved).toEqual(['Removed'])
    expect(d.foldersAdded).toEqual(['New/Added'])
    expect(d.identical).toBe(false)
  })
})

describe('MCP requests', () => {
  const mcpDoc = (mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ method: 'MCP', url: 'https://m/mcp', body: null, params: [], mcp, ...extra })
  const base = { v: 1, transport: 'http', operation: 'tools/call', tool: 'echo', arguments: '{"text":"hi"}' }

  it('shows configuration changes in an "mcp" field instead of "unchanged"', () => {
    const before = snap([r('1', 'M', null, mcpDoc(base))])
    const after = snap([r('1', 'M', null, mcpDoc({ ...base, tool: 'add', arguments: '{"a":1,"b":2}', timeoutMs: 5000 }))])
    const d = diffSnapshots(before, after)
    expect(d.summary.changed).toBe(1)
    const changes = d.requests[0].changes
    expect(changes.map((c) => c.field)).toEqual(['mcp'])
    expect(changes[0].before).toBe('transport: http\noperation: tools/call\ntool: echo\narguments:\n{"text":"hi"}')
    expect(changes[0].after).toBe('transport: http\noperation: tools/call\ntool: add\narguments:\n{"a":1,"b":2}\ntimeout: 5000ms')
  })

  it('renders a stdio configuration (command, args, env rows, cwd) and prompt arguments', () => {
    const stdio = {
      v: 1, transport: 'stdio', command: 'node', args: ['s.mjs', '--x'], cwd: '/srv',
      env: [{ key: 'B', value: '2', disabled: true }, { key: 'A', value: '{{a}}', disabled: false }],
      operation: 'prompts/get', prompt: 'greet', promptArguments: [{ key: 'name', value: 'Ada', disabled: false }], future: { x: 1 },
    }
    const d = diffSnapshots(snap([r('1', 'M', null, mcpDoc(base))]), snap([r('1', 'M', null, mcpDoc(stdio, { url: 'node s.mjs --x' }))]))
    const byField = Object.fromEntries(d.requests[0].changes.map((c) => [c.field, c]))
    expect(byField.mcp.after).toBe(
      'transport: stdio\ncommand: node\nargs: ["s.mjs","--x"]\nenv:\nA: {{a}}\n[off] B: 2\ncwd: /srv\noperation: prompts/get\nprompt: greet\nprompt arguments:\nname: Ada\nother: {"future":{"x":1}}',
    )
    // The stdio URL column is the command line, not a server URL: the server change shows in the MCP field.
    expect(byField.url).toMatchObject({ before: 'https://m/mcp', after: '' })
  })

  it('finds identical MCP requests unchanged and shows no body for them', () => {
    const s = snap([r('1', 'M', null, mcpDoc(base))])
    expect(diffSnapshots(s, s).identical).toBe(true)
    const toHttp = diffSnapshots(s, snap([r('1', 'M', null, { method: 'POST', url: 'https://m/mcp', body: { mode: 'raw', raw: 'x' } })]))
    const byField = Object.fromEntries(toHttp.requests[0].changes.map((c) => [c.field, c]))
    expect(byField.method).toMatchObject({ before: 'MCP', after: 'POST' })
    expect(byField.body.before).toBe('')
    expect(byField.mcp).toMatchObject({ after: '' })
  })

  it('leaves HTTP requests without an "mcp" field', () => {
    const d = diffSnapshots(snap([r('1', 'A', null)]), snap([r('1', 'A', null, { url: 'https://other' })]))
    expect(d.requests[0].changes.map((c) => c.field)).toEqual(['url'])
  })
})
