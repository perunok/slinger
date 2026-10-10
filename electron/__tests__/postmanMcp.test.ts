import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiRequest, Collection } from '../../shared/types'
import { newRow } from '../../src/lib/kv'
import { newMcpDraft, newMcpRequestDraft, serializeMcp } from '../../src/lib/mcpRequest'
import { buildPostmanCollection, exportPostmanCollection } from '../../src/lib/postman'
import { newDraft, parseDocument, serializeDraft, type RequestDraft } from '../../src/lib/request'
import { makeEnv, scaffold, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
})
afterEach(() => env.cleanup())

const collection: Collection = { id: 'c-src', workspaceId: 'w', name: 'MCP API', createdAt: 1, updatedAt: 1, version: 1 }

function apiRequest(id: string, sortOrder: number, draft: RequestDraft): ApiRequest {
  return { id, workspaceId: 'w', collectionId: collection.id, folderId: null, sortOrder, createdAt: 1, updatedAt: 1, version: 1, ...serializeDraft(draft) }
}

const httpMcp = (): RequestDraft => ({
  ...newMcpRequestDraft('Weather'),
  url: '{{base}}/mcp',
  headers: [newRow({ key: 'X-Team', value: 'core' }), newRow()],
  auth: { ...newDraft().auth, kind: 'bearer', bearer: { token: '{{token}}' } },
  mcp: newMcpDraft({ transport: 'sse', tool: 'get_weather', arguments: '{"city": "{{city}}"}', timeoutMs: 9000, extra: { later: true } }),
})
const stdioMcp = (): RequestDraft => ({
  ...newMcpRequestDraft('Local'),
  mcp: newMcpDraft({
    transport: 'stdio', command: 'node', args: ['server.mjs', '--port', '{{port}}'], cwd: '/srv',
    env: [newRow({ key: 'TOKEN', value: '{{secret}}' }), newRow({ key: 'OFF', value: '1', enabled: false }), newRow()],
    operation: 'prompts/get', prompt: 'greet', promptArguments: [newRow({ key: 'name', value: 'Ada' }), newRow()],
  }),
})

describe('Postman import of Slinger MCP requests', () => {
  it('lifts _slinger_mcp back to document.mcp, keeps method MCP and round-trips to the same drafts', async () => {
    const drafts = [httpMcp(), stdioMcp(), newDraft({ name: 'Plain', method: 'POST', url: 'https://api.example.com/x' })]
    const file = exportPostmanCollection({ collection, folders: [], requests: drafts.map((d, i) => apiRequest(`r${i}`, i, d)) })
    const imported = await env.api.importPostmanCollection(wsId, file)
    const stored = await env.api.listRequests(imported.collection.id)

    expect(stored.map((r) => [r.name, r.method, r.url])).toEqual([
      ['Weather', 'MCP', '{{base}}/mcp'],
      ['Local', 'MCP', 'node server.mjs --port {{port}}'],
      ['Plain', 'POST', 'https://api.example.com/x'],
    ])
    for (const [i, r] of stored.entries()) {
      const doc = JSON.parse(r.documentJson)
      const back = parseDocument(r)
      if (i < 2) {
        expect(doc.mcp).toEqual(serializeMcp(drafts[i].mcp!))
        expect(doc.source).not.toHaveProperty('_slinger_mcp')
        expect(serializeMcp(back.mcp!)).toEqual(serializeMcp(drafts[i].mcp!))
      } else {
        expect(doc).not.toHaveProperty('mcp')
        expect(back.mcp).toBeUndefined()
      }
      // Same request apart from the import's bookkeeping keys (scripts, responses, source).
      const strip = (json: string) => {
        const { scripts: _s, responses: _r, source: _src, ...rest } = JSON.parse(json)
        return rest
      }
      const original = serializeDraft(drafts[i])
      const again = serializeDraft(back)
      expect([again.name, again.method, again.url]).toEqual([original.name, original.method, original.url])
      expect(strip(again.documentJson)).toEqual(strip(original.documentJson))
    }

    // Exporting the imported collection writes the same items again.
    const reExported = buildPostmanCollection({ collection, folders: [], requests: stored })
    const first = JSON.parse(file).item
    expect(reExported.item.map((it) => [it.request, it._slinger_mcp])).toEqual(first.map((it: Record<string, unknown>) => [it.request, it._slinger_mcp]))
  })

  it('treats any item with an object _slinger_mcp as MCP and ignores a malformed one', async () => {
    const file = JSON.stringify({
      info: { name: 'Hand written' },
      item: [
        { name: 'Odd', request: { method: 'GET', url: 'https://mcp.example.com/mcp', body: { mode: 'raw', raw: 'x' } }, _slinger_mcp: { transport: 'http', tool: 'echo' } },
        { name: 'Broken', request: { method: 'GET', url: 'https://x' }, _slinger_mcp: 'nope' },
      ],
    })
    const imported = await env.api.importPostmanCollection(wsId, file)
    const [odd, broken] = await env.api.listRequests(imported.collection.id)
    expect(odd.method).toBe('MCP')
    expect(JSON.parse(odd.documentJson)).toMatchObject({ method: 'MCP', body: null, params: [], mcp: { transport: 'http', tool: 'echo' } })
    expect(parseDocument(odd).mcp).toMatchObject({ transport: 'http', tool: 'echo', operation: 'tools/call' })
    expect(broken.method).toBe('GET')
    expect(JSON.parse(broken.documentJson)).not.toHaveProperty('mcp')
  })

  it('lifts MCP items on a re-import (replace) too', async () => {
    const first = await env.api.importPostmanCollection(wsId, exportPostmanCollection({ collection, folders: [], requests: [apiRequest('a', 0, newDraft({ name: 'Old', url: 'https://x' }))] }))
    const file = exportPostmanCollection({ collection, folders: [], requests: [apiRequest('b', 0, stdioMcp())] })
    const replaced = await env.api.replaceCollectionFromPostman(first.collection.id, file, 'mcp.json')
    expect(replaced.requests.map((r) => [r.name, r.method])).toEqual([['Local', 'MCP']])
    expect(JSON.parse(replaced.requests[0].documentJson).mcp).toMatchObject({ transport: 'stdio', command: 'node', prompt: 'greet' })
  })
})
