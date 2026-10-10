/** The MCP session registry: reuse by connect fingerprint, reconnect on change, idle close of shared sessions, event log. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpClientEvent, McpConnectInput } from '../../../shared/types'
import { createMockBackend } from '../../dev/mockBackend'
import { connectFingerprint, MCP_EVENTS_PER_SESSION, MCP_SHARED_IDLE_MS, mcpConnections } from './connections.svelte'

let backend: ReturnType<typeof createMockBackend>
let emit: (e: McpClientEvent) => void
let sessions: number

const input = (over: Partial<McpConnectInput> = {}): McpConnectInput => ({
  workspaceId: 'w',
  transport: 'http',
  url: 'http://mcp.test/mcp',
  headers: [{ key: 'Authorization', value: 'Bearer a' }],
  origin: 'user',
  ...over,
})

beforeEach(async () => {
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  await mcpConnections.reset()
  sessions = 0
  vi.spyOn(backend, 'mcpClientConnect').mockImplementation(async () => ({
    sessionId: `s${++sessions}`,
    serverInfo: { name: 'Demo', version: '1' },
    protocolVersion: '2025-06-18',
    capabilities: {},
    instructions: null,
    connectMs: 1,
  }))
  vi.spyOn(backend, 'mcpClientDisconnect').mockResolvedValue()
  vi.spyOn(backend, 'onMcpClientEvent').mockImplementation((listener) => {
    emit = listener
    return () => {}
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mcpConnections', () => {
  it('reuses the session of a key while the connect input is unchanged, and reconnects when it changes', async () => {
    const a = await mcpConnections.getSession('tab:1', input())
    const again = await mcpConnections.getSession('tab:1', input({ origin: 'runner', timeoutMs: 5 }))
    expect(again.sessionId).toBe(a.sessionId)
    expect(backend.mcpClientConnect).toHaveBeenCalledTimes(1)
    expect(mcpConnections.info('tab:1')?.serverInfo.name).toBe('Demo')
    expect(mcpConnections.isConnected('tab:1')).toBe(true)

    // A new token: the old session is closed first.
    const b = await mcpConnections.getSession('tab:1', input({ headers: [{ key: 'Authorization', value: 'Bearer b' }] }))
    expect(b.sessionId).toBe('s2')
    expect(backend.mcpClientDisconnect).toHaveBeenCalledWith('s1')
    expect(mcpConnections.sessionId('tab:1')).toBe('s2')

    // Another key gets its own session.
    expect((await mcpConnections.getSession('tab:2', input())).sessionId).toBe('s3')
  })

  it('shares one connect between concurrent callers of the same key', async () => {
    const [a, b] = await Promise.all([mcpConnections.getSession(null, input()), mcpConnections.getSession(null, input())])
    expect(a.sessionId).toBe(b.sessionId)
    expect(backend.mcpClientConnect).toHaveBeenCalledTimes(1)
    expect(a.key).toBe(`fp:${await connectFingerprint(input())}`)
  })

  it('fingerprints the resolved connect input, not who starts it', async () => {
    const fp = await connectFingerprint(input())
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(await connectFingerprint(input({ origin: 'mcp', timeoutMs: 1 }))).toBe(fp)
    expect(await connectFingerprint(input({ workspaceId: 'other' }))).not.toBe(fp)
    expect(await connectFingerprint(input({ transport: 'stdio', url: undefined, command: 'node', args: ['a b'] }))).not.toBe(
      await connectFingerprint(input({ transport: 'stdio', url: undefined, command: 'node', args: ['a', 'b'] })),
    )
  })

  it('closes a shared session after 2 min without a call; tab sessions stay open', async () => {
    vi.useFakeTimers()
    const shared = await mcpConnections.getSession(null, input())
    await mcpConnections.getSession('tab:1', input())
    mcpConnections.release(shared.key)
    mcpConnections.release('tab:1')
    vi.advanceTimersByTime(MCP_SHARED_IDLE_MS - 1)
    // A new send in time cancels the countdown.
    await mcpConnections.getSession(null, input())
    vi.advanceTimersByTime(MCP_SHARED_IDLE_MS)
    expect(mcpConnections.isConnected(shared.key)).toBe(true)
    mcpConnections.release(shared.key)
    vi.advanceTimersByTime(MCP_SHARED_IDLE_MS)
    expect(mcpConnections.isConnected(shared.key)).toBe(false)
    expect(backend.mcpClientDisconnect).toHaveBeenCalledWith(shared.sessionId)
    expect(mcpConnections.isConnected('tab:1')).toBe(true)
  })

  it('keeps the last 500 events per session and forgets a session main closed', async () => {
    const conn = await mcpConnections.getSession('tab:1', input())
    for (let i = 0; i < MCP_EVENTS_PER_SESSION + 5; i++) emit({ sessionId: 's1', at: i, type: 'send', payload: { id: i } })
    emit({ sessionId: 'other', at: 0, type: 'stderr', payload: { text: 'x' } })
    const events = mcpConnections.events(conn.sessionId)
    expect(events).toHaveLength(MCP_EVENTS_PER_SESSION)
    expect(events[0].at).toBe(5)
    expect(mcpConnections.events('other')).toHaveLength(1)
    expect(mcpConnections.events(null)).toEqual([])

    emit({ sessionId: 's1', at: 999, type: 'closed', payload: { message: 'gone' } })
    expect(mcpConnections.isConnected('tab:1')).toBe(false)
    expect(mcpConnections.events('s1').at(-1)?.type).toBe('closed')
    mcpConnections.clearEvents('s1')
    expect(mcpConnections.events('s1')).toEqual([])
    // Reconnects on the next use.
    expect((await mcpConnections.getSession('tab:1', input())).sessionId).toBe('s2')
  })

  it('subscribes once, and disconnect closes the session in main (unknown keys are a no-op)', async () => {
    await mcpConnections.getSession('tab:1', input())
    await mcpConnections.getSession('tab:2', input())
    expect(backend.onMcpClientEvent).toHaveBeenCalledTimes(1)
    await mcpConnections.disconnect('tab:1')
    await mcpConnections.disconnect('nope')
    expect(backend.mcpClientDisconnect).toHaveBeenCalledTimes(1)
    expect(mcpConnections.keyOf('s2')).toBe('tab:2')
    await mcpConnections.disconnectAll()
    expect(mcpConnections.connections).toEqual({})
  })

  it('keeps the newest of two overlapping connects of a key, whichever finishes first, and closes the other', async () => {
    const resolvers: Array<() => void> = []
    vi.mocked(backend.mcpClientConnect).mockImplementation(
      (i) =>
        new Promise((resolve) => {
          const id = `s-${i.url?.endsWith('/a') ? 'a' : 'b'}`
          resolvers.push(() => resolve({ sessionId: id, serverInfo: { name: 'Demo', version: '1' }, protocolVersion: null, capabilities: {}, instructions: null, connectMs: 1 }))
        }),
    )
    const a = mcpConnections.getSession('tab:1', input({ url: 'http://mcp.test/a' }))
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    const b = mcpConnections.getSession('tab:1', input({ url: 'http://mcp.test/b' }))
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    // B (the newer one) finishes first, then A.
    resolvers[1]()
    expect((await b).sessionId).toBe('s-b')
    expect(mcpConnections.isConnecting('tab:1')).toBe(false)
    resolvers[0]()
    await a
    expect(mcpConnections.sessionId('tab:1')).toBe('s-b')
    expect(backend.mcpClientDisconnect).toHaveBeenCalledWith('s-a')
    expect(backend.mcpClientDisconnect).not.toHaveBeenCalledWith('s-b')
  })

  it('closes a connect that finishes after its key was disconnected', async () => {
    let finish!: () => void
    vi.mocked(backend.mcpClientConnect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ sessionId: 'late', serverInfo: { name: 'Demo', version: '1' }, protocolVersion: null, capabilities: {}, instructions: null, connectMs: 1 })
        }),
    )
    const pending = mcpConnections.getSession('tab:1', input())
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await mcpConnections.disconnect('tab:1')
    finish()
    await pending
    expect(mcpConnections.isConnected('tab:1')).toBe(false)
    expect(mcpConnections.isConnecting('tab:1')).toBe(false)
    expect(backend.mcpClientDisconnect).toHaveBeenCalledWith('late')
  })

  it('starts the idle countdown of a shared session only when no send is in flight on it', async () => {
    vi.useFakeTimers()
    const first = await mcpConnections.getSession(null, input())
    const second = await mcpConnections.getSession(null, input())
    expect(second.sessionId).toBe(first.sessionId)
    // The first send finished; the second one (a long call) is still running.
    mcpConnections.release(first.key)
    vi.advanceTimersByTime(MCP_SHARED_IDLE_MS * 3)
    expect(mcpConnections.isConnected(first.key)).toBe(true)
    expect(backend.mcpClientDisconnect).not.toHaveBeenCalled()
    mcpConnections.release(second.key)
    vi.advanceTimersByTime(MCP_SHARED_IDLE_MS)
    expect(mcpConnections.isConnected(first.key)).toBe(false)
  })

  it('does not keep a session whose connect failed', async () => {
    vi.mocked(backend.mcpClientConnect).mockRejectedValueOnce({ name: 'IpcError', code: 'network_error', message: 'refused' })
    await expect(mcpConnections.getSession('tab:1', input())).rejects.toMatchObject({ message: 'refused' })
    expect(mcpConnections.isConnected('tab:1')).toBe(false)
    expect(mcpConnections.isConnecting('tab:1')).toBe(false)
    expect((await mcpConnections.getSession('tab:1', input())).sessionId).toBe('s1')
  })
})
