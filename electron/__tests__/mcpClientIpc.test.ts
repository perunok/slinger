import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpCallInput, McpConnectInput } from '../../shared/types'
import type { McpClientApi } from '../mcpClient/types'
import { makeEnv, NIL_UUID, type TestEnv } from './helpers'

// The IPC boundary of the MCP client (ipc/api.ts): validation only, against a fake core.mcpClient that records calls.

let env: TestEnv
let calls: Array<[string, unknown[]]>

function fakeClient(): McpClientApi {
  const rec =
    (name: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push([name, args])
      return result instanceof Function ? result() : result
    }
  return {
    connect: rec('connect', async () => ({
      sessionId: 's1',
      serverInfo: { name: 'fake', version: '1' },
      protocolVersion: '2025-06-18',
      capabilities: {},
      instructions: null,
      connectMs: 1,
    })),
    list: rec('list', async () => ({ kind: 'tools', items: [], truncated: false })),
    call: rec('call', async () => ({ ok: true, isError: false, result: {}, error: null, durationMs: 1 })),
    cancel: rec('cancel'),
    disconnect: rec('disconnect', async () => undefined),
    trustCommand: rec('trustCommand'),
    closeAll: rec('closeAll', async () => undefined),
  } as McpClientApi
}

beforeEach(() => {
  env = makeEnv()
  calls = []
  env.core.mcpClient = fakeClient()
})
afterEach(() => env.cleanup())

const http = (over: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId: NIL_UUID,
  transport: 'http',
  url: 'http://127.0.0.1:3000/mcp',
  headers: [{ key: 'Authorization', value: 'Bearer abc' }],
  origin: 'user',
  ...over,
})
const stdio = (over: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId: NIL_UUID,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server'],
  env: [{ key: 'TOKEN', value: 'x' }],
  cwd: '',
  origin: 'user',
  ...over,
})
const call = (over: Partial<McpCallInput> = {}): McpCallInput => ({
  sessionId: 's1',
  operation: 'tools/call',
  name: 'echo',
  arguments: { text: 'hi', nested: { list: [1, 'two'] } },
  requestRunId: 'run-1',
  workspaceId: NIL_UUID,
  historyUrl: '{{base}}/mcp',
  ...over,
})
const invalid = { code: 'invalid_input' }

describe('mcpClientConnect', () => {
  it('passes valid http, sse and stdio inputs through unchanged', async () => {
    await expect(env.api.mcpClientConnect(http())).resolves.toMatchObject({ sessionId: 's1' })
    await env.api.mcpClientConnect(http({ transport: 'sse', url: 'https://example.com/sse', timeoutMs: 5000 }))
    await env.api.mcpClientConnect(stdio())
    expect(calls.map(([n]) => n)).toEqual(['connect', 'connect', 'connect'])
    expect(calls[2][1][0]).toEqual(stdio())
  })

  it('requires an http(s) URL for http and sse', async () => {
    for (const url of [undefined, '', 'ftp://host/x', 'file:///etc/passwd', 'not a url', 'javascript:alert(1)']) {
      await expect(env.api.mcpClientConnect(http({ url })), String(url)).rejects.toMatchObject(invalid)
      await expect(env.api.mcpClientConnect(http({ transport: 'sse', url })), String(url)).rejects.toMatchObject(invalid)
    }
    expect(calls).toEqual([])
  })

  it('requires a command for stdio', async () => {
    await expect(env.api.mcpClientConnect(stdio({ command: undefined }))).rejects.toMatchObject(invalid)
    await expect(env.api.mcpClientConnect(stdio({ command: '' }))).rejects.toMatchObject(invalid)
    expect(calls).toEqual([])
  })

  it('rejects bad enums, ids, timeouts, unknown keys and oversized values', async () => {
    const bad: unknown[] = [
      { ...http(), transport: 'websocket' },
      { ...http(), origin: 'cloud' },
      { ...http(), workspaceId: 'nope' },
      { ...http(), timeoutMs: 0 },
      { ...http(), timeoutMs: 600_001 },
      { ...http(), timeoutMs: 1.5 },
      { ...http(), extra: true },
      { ...http(), headers: [{ key: 'a', value: 'x'.repeat(65_537) }] },
      { ...stdio(), args: ['x'.repeat(32_769)] },
      { ...stdio(), env: [{ key: '', value: 'x' }] },
      { ...stdio(), cwd: 'x'.repeat(4097) },
    ]
    for (const input of bad) await expect(env.api.mcpClientConnect(input as McpConnectInput), JSON.stringify(input).slice(0, 80)).rejects.toMatchObject(invalid)
    expect(calls).toEqual([])
  })

  it('rejects unresolved {{variables}} in everything that reaches the server or the command line', async () => {
    const bad: McpConnectInput[] = [
      http({ url: 'http://{{host}}/mcp' }),
      http({ headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] }),
      http({ headers: [{ key: '{{name}}', value: 'x' }] }),
      stdio({ command: '{{bin}}' }),
      stdio({ args: ['--key', '{{key}}'] }),
      stdio({ env: [{ key: 'TOKEN', value: '{{ token }}' }] }),
      stdio({ cwd: '{{home}}/x' }),
    ]
    for (const input of bad) {
      await expect(env.api.mcpClientConnect(input), JSON.stringify(input)).rejects.toMatchObject({
        ...invalid,
        message: expect.stringContaining('Unresolved variable'),
      })
    }
    expect(calls).toEqual([])
  })
})

describe('mcpClientCall', () => {
  it('passes a valid call through, history fields included', async () => {
    const input = call({
      requestId: 'r1',
      requestName: 'Echo',
      historySource: 'mcp',
      timeoutMs: 600_000,
      historyDetail: 'tools/call echo',
      scriptSessionId: 'script-session',
    })
    await expect(env.api.mcpClientCall(input)).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual([['call', [input]]])
  })

  it('needs a name for tools and prompts, a URI for resources, string prompt arguments', async () => {
    await expect(env.api.mcpClientCall(call({ name: undefined }))).rejects.toMatchObject(invalid)
    await expect(env.api.mcpClientCall(call({ operation: 'prompts/get', name: '', arguments: {} }))).rejects.toMatchObject(invalid)
    await expect(env.api.mcpClientCall(call({ operation: 'resources/read', name: undefined, arguments: undefined }))).rejects.toMatchObject(invalid)
    await expect(env.api.mcpClientCall(call({ operation: 'prompts/get', name: 'greet', arguments: { n: 1 } }))).rejects.toMatchObject(invalid)
    expect(calls).toEqual([])
    await env.api.mcpClientCall(call({ operation: 'resources/read', name: undefined, uri: 'demo://readme', arguments: undefined }))
    await env.api.mcpClientCall(call({ operation: 'prompts/get', name: 'greet', arguments: { name: 'Ana' } }))
    expect(calls).toHaveLength(2)
  })

  it('rejects bad operations, timeouts, a missing historyUrl and non-object arguments', async () => {
    const bad: unknown[] = [
      { ...call(), operation: 'tools/list' },
      { ...call(), timeoutMs: 600_001 },
      { ...call(), timeoutMs: -1 },
      { ...call(), historyUrl: undefined },
      { ...call(), historySource: 'user' },
      { ...call(), arguments: [1, 2] },
      { ...call(), arguments: 'text' },
      { ...call(), sessionId: '' },
      { ...call(), requestRunId: 'x'.repeat(129) },
      { ...call(), workspaceId: 'nope' },
    ]
    for (const input of bad) await expect(env.api.mcpClientCall(input as McpCallInput), JSON.stringify(input)).rejects.toMatchObject(invalid)
    expect(calls).toEqual([])
  })

  it('rejects {{variables}} in the name, URI and argument keys or values, but not in historyUrl or historyDetail', async () => {
    const bad: McpCallInput[] = [
      call({ name: '{{tool}}' }),
      call({ arguments: { text: '{{greeting}}' } }),
      call({ arguments: { deep: { list: ['ok', '{{x}}'] } } }),
      call({ arguments: { '{{key}}': 1 } }),
      call({ operation: 'resources/read', uri: 'demo://users/{{id}}', name: undefined, arguments: undefined }),
    ]
    for (const input of bad) await expect(env.api.mcpClientCall(input), JSON.stringify(input)).rejects.toMatchObject(invalid)
    expect(calls).toEqual([])
    await env.api.mcpClientCall(call({ historyUrl: '{{base}}/mcp {{secret}}', historyDetail: 'resources/read {{uri}}', requestName: '{{odd}} name' }))
    expect(calls).toHaveLength(1)
  })
})

describe('the other MCP client methods', () => {
  it('list validates the session id and kind', async () => {
    await expect(env.api.mcpClientList('s1', 'tools')).resolves.toMatchObject({ kind: 'tools' })
    for (const kind of ['resources', 'resourceTemplates', 'prompts'] as const) await env.api.mcpClientList('s1', kind)
    await expect(env.api.mcpClientList('s1', 'roots' as never)).rejects.toMatchObject(invalid)
    await expect(env.api.mcpClientList('', 'tools')).rejects.toMatchObject(invalid)
    expect(calls.map(([n, a]) => [n, a[1]])).toEqual([
      ['list', 'tools'],
      ['list', 'resources'],
      ['list', 'resourceTemplates'],
      ['list', 'prompts'],
    ])
  })

  it('cancel and disconnect take bounded ids', async () => {
    await env.api.mcpClientCancel('run-1')
    await env.api.mcpClientDisconnect('s1')
    await expect(env.api.mcpClientCancel('x'.repeat(129))).rejects.toMatchObject(invalid)
    await expect(env.api.mcpClientDisconnect(42 as never)).rejects.toMatchObject(invalid)
    expect(calls).toEqual([
      ['cancel', ['run-1']],
      ['disconnect', ['s1']],
    ])
  })

  it('trustCommand needs the exact command, args, cwd and env, all resolved', async () => {
    await env.api.mcpClientTrustCommand({ command: 'node', args: ['server.js'], cwd: '', env: [{ key: 'DEBUG', value: '1' }] })
    // An older caller without env allows the command with no extra environment only.
    await env.api.mcpClientTrustCommand({ command: 'node', args: [], cwd: '' } as never)
    expect(calls).toEqual([
      ['trustCommand', [{ command: 'node', args: ['server.js'], cwd: '', env: [{ key: 'DEBUG', value: '1' }] }]],
      ['trustCommand', [{ command: 'node', args: [], cwd: '', env: [] }]],
    ])
    const bad: unknown[] = [
      { command: '', args: [], cwd: '', env: [] },
      { command: 'node', cwd: '', env: [] },
      { command: 'node', args: [], cwd: '', env: [], extra: 1 },
      { command: 'node', args: ['{{script}}'], cwd: '', env: [] },
      { command: 'node', args: [], cwd: '{{dir}}', env: [] },
      { command: 'node', args: [], cwd: '', env: [{ key: 'TOKEN', value: '{{token}}' }] },
      { command: 'node', args: [], cwd: '', env: [{ key: '', value: 'x' }] },
    ]
    for (const input of bad) await expect(env.api.mcpClientTrustCommand(input as never), JSON.stringify(input)).rejects.toMatchObject(invalid)
    expect(calls).toHaveLength(2)
  })
})

describe('core wiring', () => {
  it('core has an MCP client before the real service exists', async () => {
    const plain = makeEnv()
    try {
      expect(typeof plain.core.mcpClient.connect).toBe('function')
      await expect(plain.core.mcpClient.closeAll()).resolves.toBeUndefined()
    } finally {
      plain.cleanup()
    }
  })
})
