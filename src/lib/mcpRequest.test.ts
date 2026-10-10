import { describe, expect, it } from 'vitest'
import { dataRows, newRow } from './kv'
import {
  MCP_METHOD,
  isMcpDraft,
  mcpDisplayUrl,
  mcpTemplateTexts,
  newMcpDraft,
  newMcpRequestDraft,
  parseMcp,
  serializeMcp,
} from './mcpRequest'
import { draftFingerprint, newDraft, parseDocument, serializeDraft, templateTexts } from './request'

const wire = {
  v: 1,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/server', '--token={{token}}'],
  env: [
    { key: 'API_KEY', value: '{{apiKey}}', disabled: false },
    { key: 'DEBUG', value: '1', disabled: true },
  ],
  cwd: '{{home}}/srv',
  operation: 'tools/call',
  tool: 'get_weather',
  arguments: '{\n  "city": "{{city}}"\n}',
  uri: 'demo://readme',
  prompt: 'greet',
  promptArguments: [{ key: 'name', value: '{{user}}', disabled: false }],
  timeoutMs: 5000,
}

describe('parseMcp / serializeMcp', () => {
  it('round-trips the wire format exactly, unknown keys kept verbatim after the known ones', () => {
    const withExtra = { ...wire, future: { a: [1, 2] }, note: 'x' }
    const d = parseMcp(withExtra)
    expect(d.extra).toEqual({ future: { a: [1, 2] }, note: 'x' })
    expect(dataRows(d.env).map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['API_KEY', '{{apiKey}}', true],
      ['DEBUG', '1', false],
    ])
    expect(serializeMcp(d)).toEqual(withExtra)
    expect(Object.keys(serializeMcp(d))).toEqual(Object.keys(withExtra))
  })

  it('is tolerant: missing or bad fields get defaults', () => {
    for (const bad of [undefined, null, 'x', 42, [], {}]) {
      const d = parseMcp(bad)
      expect({ ...d, env: dataRows(d.env), promptArguments: dataRows(d.promptArguments) }).toEqual({
        ...newMcpDraft(),
        env: [],
        promptArguments: [],
      })
    }
    const d = parseMcp({
      transport: 'websocket',
      operation: 'tools/list',
      command: 7,
      args: ['a', 2, null, { x: 1 }],
      env: 'nope',
      promptArguments: [null, 'x', { key: 'k' }],
      timeoutMs: -5,
      arguments: { city: 'Oslo' },
    })
    expect(d.transport).toBe('http')
    expect(d.operation).toBe('tools/call')
    expect(d.command).toBe('')
    expect(d.args).toEqual(['a', '2'])
    expect(dataRows(d.env)).toEqual([])
    expect(dataRows(d.promptArguments).map((r) => [r.key, r.value, r.enabled])).toEqual([['k', '', true]])
    expect(d.timeoutMs).toBeNull()
    expect(JSON.parse(d.arguments)).toEqual({ city: 'Oslo' })
    expect(parseMcp({ timeoutMs: 1.5 }).timeoutMs).toBeNull()
  })

  it('writes rows without the trailing empty row, version 1, defaults for a new draft', () => {
    expect(serializeMcp(newMcpDraft())).toEqual({
      v: 1,
      transport: 'http',
      command: '',
      args: [],
      env: [],
      cwd: '',
      operation: 'tools/call',
      tool: '',
      arguments: '{}',
      uri: '',
      prompt: '',
      promptArguments: [],
      timeoutMs: null,
    })
    // An extra key named like an own key never overrides it.
    expect(serializeMcp(newMcpDraft({ extra: { v: 9, tool: 'x', other: 1 } }))).toMatchObject({ v: 1, tool: '', other: 1 })
  })
})

describe('MCP drafts in a request document', () => {
  it('a new MCP request saves as method MCP with the mcp key and empty body/params', () => {
    const d = newMcpRequestDraft()
    expect(isMcpDraft(d)).toBe(true)
    expect(isMcpDraft(newDraft())).toBe(false)
    d.url = '{{base}}/mcp'
    const s = serializeDraft(d)
    expect(s).toMatchObject({ name: 'New MCP Request', method: MCP_METHOD, url: '{{base}}/mcp' })
    const doc = JSON.parse(s.documentJson)
    expect(doc).toMatchObject({ method: 'MCP', url: '{{base}}/mcp', body: null, params: [], mcp: serializeMcp(newMcpDraft()) })
    expect(newMcpRequestDraft('Weather').name).toBe('Weather')
  })

  it('round-trips through parseDocument with a stable fingerprint, keeping headers, auth and extras', () => {
    const d = newMcpRequestDraft('Weather')
    d.url = 'https://mcp.example.com/mcp'
    d.headers = [newRow({ key: 'X-Team', value: '{{team}}' }), newRow()]
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: '{{token}}' } }
    d.extras = { event: [{ listen: 'test', script: { exec: ['pm.test("x", () => {})'] } }] }
    d.mcp = parseMcp({ ...wire, transport: 'http' })
    const s = serializeDraft(d)
    const back = parseDocument({ name: s.name, method: s.method, url: s.url, documentJson: s.documentJson })
    expect(back.mcp).toBeDefined()
    expect(back.url).toBe('https://mcp.example.com/mcp')
    expect(back.auth.kind).toBe('bearer')
    expect(back.extras).toEqual(d.extras)
    expect(draftFingerprint(back)).toBe(draftFingerprint(d))
    expect(serializeDraft(back).documentJson).toBe(s.documentJson)
  })

  it('stdio: the url column is the command line; the draft url stays empty', () => {
    const d = newMcpRequestDraft()
    d.url = 'http://left-over'
    d.mcp = parseMcp(wire)
    expect(mcpDisplayUrl(d)).toBe('npx -y @acme/server --token={{token}}')
    const s = serializeDraft(d)
    expect(s.url).toBe('npx -y @acme/server --token={{token}}')
    expect(JSON.parse(s.documentJson).url).toBe(s.url)
    const back = parseDocument({ name: s.name, method: s.method, url: s.url, documentJson: s.documentJson })
    expect(back.url).toBe('')
    expect(serializeDraft(back).documentJson).toBe(s.documentJson)
    d.mcp.command = 'x'.repeat(9000)
    expect(mcpDisplayUrl(d)).toHaveLength(8192)
  })

  it('reads method MCP without an mcp object (and an mcp object under another method) as an MCP draft', () => {
    const a = parseDocument({ name: 'A', method: 'MCP', url: 'http://h/mcp', documentJson: '{}' })
    expect(a.mcp).toEqual({ ...newMcpDraft(), env: a.mcp!.env, promptArguments: a.mcp!.promptArguments })
    expect(a).toMatchObject({ method: 'MCP', url: 'http://h/mcp' })
    const b = parseDocument({ name: 'B', method: 'GET', url: 'x', documentJson: JSON.stringify({ method: 'GET', url: 'http://h/?q=1', mcp: {} }) })
    expect(b.method).toBe('MCP')
    expect(dataRows(b.params)).toEqual([])
    expect(b.extras).not.toHaveProperty('mcp')
  })

  it('HTTP documents never get an mcp key', () => {
    const d = parseDocument({ name: 'H', method: 'POST', url: 'http://h', documentJson: JSON.stringify({ method: 'POST', url: 'http://h' }) })
    expect(d.mcp).toBeUndefined()
    expect(JSON.parse(serializeDraft(d).documentJson)).not.toHaveProperty('mcp')
  })
})

describe('template texts', () => {
  it('lists only what the transport and the operation use', () => {
    const stdio = parseMcp(wire)
    expect(mcpTemplateTexts(stdio)).toEqual(['npx', '-y', '@acme/server', '--token={{token}}', '{{apiKey}}', '{{home}}/srv', wire.arguments])
    const http = { ...stdio, transport: 'http' as const }
    expect(mcpTemplateTexts(http)).toEqual([wire.arguments])
    expect(mcpTemplateTexts({ ...http, operation: 'resources/read' })).toEqual(['demo://readme'])
    expect(mcpTemplateTexts({ ...http, operation: 'prompts/get' })).toEqual(['{{user}}'])
  })

  it('templateTexts of an MCP draft: url, headers and auth only for http/sse', () => {
    const d = newMcpRequestDraft()
    d.url = '{{base}}/mcp'
    d.headers = [newRow({ key: 'X-A', value: '{{a}}' }), newRow({ key: 'X-Off', value: '{{off}}', enabled: false })]
    d.auth = { ...d.auth, kind: 'basic', basic: { username: '{{u}}', password: '{{p}}' } }
    d.mcp = parseMcp({ ...wire, transport: 'sse' })
    expect(templateTexts(d)).toEqual(['{{base}}/mcp', 'X-A', '{{a}}', '{{u}}', '{{p}}', wire.arguments])
    d.mcp.transport = 'stdio'
    expect(templateTexts(d)).toEqual(mcpTemplateTexts(d.mcp))
  })
})
