import { describe, expect, it } from 'vitest'
import type { ApiRequest, Collection } from '../../../shared/types'
import { newRow } from '../../lib/kv'
import { newMcpDraft, newMcpRequestDraft, serializeMcp } from '../../lib/mcpRequest'
import { exportPostmanCollection } from '../../lib/postman'
import { newDraft, parseDocument, serializeDraft, type RequestDraft } from '../../lib/request'
import { createMockBackend } from '../mockBackend'

const collection: Collection = { id: 'c-src', workspaceId: 'w', name: 'MCP API', createdAt: 1, updatedAt: 1, version: 1 }
const apiRequest = (id: string, sortOrder: number, draft: RequestDraft): ApiRequest => ({
  id, workspaceId: 'w', collectionId: collection.id, folderId: null, sortOrder, createdAt: 1, updatedAt: 1, version: 1, ...serializeDraft(draft),
})

describe('mock Postman import of Slinger MCP requests', () => {
  it('lifts _slinger_mcp back to document.mcp like the main-process importer', async () => {
    const api = createMockBackend({ latencyMs: 0, seed: false })
    const ws = await api.createWorkspace('W')
    const stdio: RequestDraft = {
      ...newMcpRequestDraft('Local'),
      mcp: newMcpDraft({ transport: 'stdio', command: 'node', args: ['s.mjs'], env: [newRow({ key: 'K', value: '{{v}}' }), newRow()], operation: 'resources/read', uri: 'demo://readme' }),
    }
    const http: RequestDraft = { ...newMcpRequestDraft('Remote'), url: 'https://mcp.example.com/mcp', mcp: newMcpDraft({ tool: 'echo', arguments: '{"text":"hi"}' }) }
    const drafts = [stdio, http, newDraft({ name: 'Plain', url: 'https://x' })]
    const file = exportPostmanCollection({ collection, folders: [], requests: drafts.map((d, i) => apiRequest(`r${i}`, i, d)) })

    const res = await api.importPostmanCollection(ws.id, file)
    const stored = await api.listRequests(res.collection.id)
    expect(stored.map((r) => [r.name, r.method, r.url])).toEqual([
      ['Local', 'MCP', 'node s.mjs'],
      ['Remote', 'MCP', 'https://mcp.example.com/mcp'],
      ['Plain', 'GET', 'https://x'],
    ])
    for (const i of [0, 1]) {
      const doc = JSON.parse(stored[i].documentJson)
      expect(doc).toMatchObject({ method: 'MCP', body: null, params: [] })
      expect(doc.mcp).toEqual(serializeMcp(drafts[i].mcp!))
      expect(doc.source).not.toHaveProperty('_slinger_mcp')
      expect(serializeMcp(parseDocument(stored[i]).mcp!)).toEqual(serializeMcp(drafts[i].mcp!))
    }
    expect(parseDocument(stored[2]).mcp).toBeUndefined()
  })
})
