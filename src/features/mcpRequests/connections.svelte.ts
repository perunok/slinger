/**
 * Open MCP client sessions (MCP requests), shared by the request view, executeDraft, the collection runner, workflows
 * and AI assistants. Main owns the sessions themselves (electron/mcpClient); this registry maps a key to the session
 * opened for it and keeps the message log pushed on 'mcp-client:event'.
 *
 *   - A request tab uses the key `tab:<tabId>`: its session stays open until the tab disconnects (or main closes it
 *     after 15 min idle).
 *   - Every other send uses `fp:<fingerprint>` (`getSession(null, ...)`), so runs that hit the same server share one
 *     session; it is closed 2 min after its last call finished (each `getSession` is matched by a `release`, and the
 *     countdown starts only when no call is in flight).
 *
 * `getSession` reuses the key's session only while the resolved connect input is unchanged (same fingerprint): a new
 * URL, header, token or command reconnects.
 */
import type { McpClientEvent, McpConnectInput, McpSessionInfo } from '../../../shared/types'
import { api } from '../../lib/ipc'

/** Events kept per session (oldest dropped first). */
export const MCP_EVENTS_PER_SESSION = 500
/** Sessions whose log is kept after they closed (oldest dropped first). */
const LOGS_KEPT = 50
/** `fp:` sessions are closed after this long without a call. */
export const MCP_SHARED_IDLE_MS = 2 * 60_000

export interface McpConnection {
  key: string
  sessionId: string
  info: McpSessionInfo
  fingerprint: string
  workspaceId: string
}

/** sha256 (hex) of the resolved connect input, without who starts it or the connect timeout. */
export async function connectFingerprint(input: McpConnectInput): Promise<string> {
  const { origin: _origin, timeoutMs: _timeout, ...rest } = input
  const fields = [rest.workspaceId, rest.transport, rest.url ?? '', rest.headers ?? [], rest.command ?? '', rest.args ?? [], rest.env ?? [], rest.cwd ?? '']
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

class McpConnections {
  /** Open sessions by key. */
  connections = $state<Record<string, McpConnection>>({})
  /** Keys whose connect is in flight. */
  connecting = $state<Record<string, boolean>>({})
  /** Bumped on every event, so readers of `events()` update. */
  revision = $state(0)

  #events = new Map<string, McpClientEvent[]>()
  #pending = new Map<string, { fingerprint: string; promise: Promise<McpConnection> }>()
  /** The latest connect attempt per key: a connect that finishes after a newer one started (or a disconnect) is closed. */
  #attempts = new Map<string, number>()
  #attemptSeq = 0
  /** `fp:` keys: sends between their getSession and release (the idle countdown waits for 0). */
  #inflight = new Map<string, number>()
  #idle = new Map<string, ReturnType<typeof setTimeout>>()
  #unsubscribe: (() => void) | null = null

  /** Idempotent: listens to the push channel. */
  subscribe(): void {
    if (this.#unsubscribe) return
    this.#unsubscribe = api().onMcpClientEvent((e) => this.#onEvent(e))
  }

  /**
   * The open session for `key` when its connect input is unchanged, else a new one (closing the old one). `key` null:
   * the shared `fp:<fingerprint>` session, closed 2 min after the last call (call `release` when done).
   */
  async getSession(key: string | null, input: McpConnectInput): Promise<McpConnection> {
    this.subscribe()
    const fingerprint = await connectFingerprint(input)
    const k = key ?? `fp:${fingerprint}`
    this.#clearIdle(k)
    const conn = await this.#open(k, fingerprint, input)
    if (k.startsWith('fp:')) {
      this.#inflight.set(k, (this.#inflight.get(k) ?? 0) + 1)
      // Another send may have released (and started the countdown) while this one was connecting.
      this.#clearIdle(k)
    }
    return conn
  }

  async #open(k: string, fingerprint: string, input: McpConnectInput): Promise<McpConnection> {
    const open = this.connections[k]
    if (open && open.fingerprint === fingerprint) return open
    const pending = this.#pending.get(k)
    if (pending && pending.fingerprint === fingerprint) return pending.promise
    const attempt = ++this.#attemptSeq
    this.#attempts.set(k, attempt)
    const promise = this.#connect(k, attempt, fingerprint, input, open ?? null)
    this.#pending.set(k, { fingerprint, promise })
    try {
      return await promise
    } finally {
      if (this.#pending.get(k)?.promise === promise) this.#pending.delete(k)
    }
  }

  async #connect(key: string, attempt: number, fingerprint: string, input: McpConnectInput, previous: McpConnection | null): Promise<McpConnection> {
    this.connecting[key] = true
    try {
      if (previous) {
        if (this.connections[key] === previous) delete this.connections[key]
        await this.#close(previous.sessionId)
      }
      const info = await api().mcpClientConnect(input)
      const conn: McpConnection = { key, sessionId: info.sessionId, info, fingerprint, workspaceId: input.workspaceId }
      // A newer connect for this key (or a disconnect) happened meanwhile, whichever finishes first: this one is stale.
      if (this.#attempts.get(key) !== attempt) {
        void this.#close(info.sessionId)
        return conn
      }
      const replaced = this.connections[key]
      if (replaced && replaced.sessionId !== conn.sessionId) void this.#close(replaced.sessionId)
      this.connections[key] = conn
      return conn
    } finally {
      if (this.#attempts.get(key) === attempt || !this.#pending.has(key)) delete this.connecting[key]
    }
  }

  /**
   * A send on the key's session finished (one call per getSession): an `fp:` session starts its idle countdown once no
   * send is in flight on it.
   */
  release(key: string): void {
    if (!key.startsWith('fp:')) return
    const left = (this.#inflight.get(key) ?? 1) - 1
    if (left > 0) {
      this.#inflight.set(key, left)
      return
    }
    this.#inflight.delete(key)
    if (!this.connections[key]) return
    this.#clearIdle(key)
    this.#idle.set(
      key,
      setTimeout(() => {
        this.#idle.delete(key)
        void this.disconnect(key)
      }, MCP_SHARED_IDLE_MS),
    )
  }

  /** The key whose session this is (null when it is not open). */
  keyOf(sessionId: string): string | null {
    return Object.values(this.connections).find((c) => c.sessionId === sessionId)?.key ?? null
  }

  async disconnect(key: string): Promise<void> {
    this.#clearIdle(key)
    // A connect still in flight for this key is closed when it finishes.
    this.#attempts.delete(key)
    this.#pending.delete(key)
    const conn = this.connections[key]
    if (!conn) return
    delete this.connections[key]
    await this.#close(conn.sessionId)
  }

  /** Closes every session (workspace switch, tests). */
  async disconnectAll(): Promise<void> {
    await Promise.all(Object.keys(this.connections).map((k) => this.disconnect(k)))
  }

  /** Drops a session main no longer knows (it answered not_found), without asking main to close it. */
  forget(key: string): void {
    this.#clearIdle(key)
    delete this.connections[key]
  }

  info(key: string): McpSessionInfo | null {
    return this.connections[key]?.info ?? null
  }

  sessionId(key: string): string | null {
    return this.connections[key]?.sessionId ?? null
  }

  isConnected(key: string): boolean {
    return key in this.connections
  }

  isConnecting(key: string): boolean {
    return this.connecting[key] === true
  }

  /** The session's message log, oldest first (at most 500 events). Reactive. */
  events(sessionId: string | null): readonly McpClientEvent[] {
    void this.revision
    return sessionId ? (this.#events.get(sessionId) ?? []) : []
  }

  clearEvents(sessionId: string): void {
    if (!this.#events.delete(sessionId)) return
    this.revision++
  }

  /** Back to nothing: closes the sessions, drops the logs and unsubscribes (tests, app reset). */
  async reset(): Promise<void> {
    for (const t of this.#idle.values()) clearTimeout(t)
    this.#idle.clear()
    this.#pending.clear()
    this.#attempts.clear()
    this.#inflight.clear()
    const open = Object.values(this.connections)
    this.connections = {}
    this.connecting = {}
    await Promise.all(open.map((c) => this.#close(c.sessionId)))
    this.#events.clear()
    this.revision++
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  #onEvent(e: McpClientEvent): void {
    const list = this.#events.get(e.sessionId) ?? []
    const next = list.length >= MCP_EVENTS_PER_SESSION ? [...list.slice(list.length - MCP_EVENTS_PER_SESSION + 1), e] : [...list, e]
    this.#events.delete(e.sessionId)
    this.#events.set(e.sessionId, next)
    if (this.#events.size > LOGS_KEPT) this.#pruneLogs()
    if (e.type === 'closed') {
      const key = this.keyOf(e.sessionId)
      if (key) this.forget(key)
    }
    this.revision++
  }

  /** Drops the logs of the sessions that closed longest ago (open sessions keep theirs). */
  #pruneLogs(): void {
    const open = new Set(Object.values(this.connections).map((c) => c.sessionId))
    for (const id of this.#events.keys()) {
      if (this.#events.size <= LOGS_KEPT) break
      if (!open.has(id)) this.#events.delete(id)
    }
  }

  #clearIdle(key: string): void {
    const t = this.#idle.get(key)
    if (t !== undefined) clearTimeout(t)
    this.#idle.delete(key)
  }

  async #close(sessionId: string): Promise<void> {
    try {
      await api().mcpClientDisconnect(sessionId)
    } catch {
      /* already closed */
    }
  }
}

export const mcpConnections = new McpConnections()
