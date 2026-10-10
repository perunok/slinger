/**
 * MCP client (MCP requests): Slinger connects to an MCP server and runs one operation. This file is the contract the IPC
 * layer (ipc/api.ts) and core.ts build against; the implementation lives in ./service.ts (McpClientService).
 *
 * Every input arrives validated and fully resolved (no `{{variables}}`); see the zod schemas in ipc/api.ts.
 */
import type { Db } from '../db/database'
import type {
  McpCallInput,
  McpCallOutcome,
  McpClientEvent,
  McpConnectInput,
  McpListKind,
  McpListResult,
  McpSessionInfo,
  McpTrustCommandInput,
} from '../../shared/types'

/** What the IPC layer calls; one method per `mcpClient*` IPC method, plus closeAll for app quit. */
export interface McpClientApi {
  connect(input: McpConnectInput): Promise<McpSessionInfo>
  list(sessionId: string, kind: McpListKind): Promise<McpListResult>
  /** Never rejects for tool/protocol errors (ok: false); only for an unknown session. */
  call(input: McpCallInput): Promise<McpCallOutcome>
  /** Aborts the call with this requestRunId; no-op when unknown. */
  cancel(requestRunId: string): void
  /** No-op when unknown. */
  disconnect(sessionId: string): Promise<void>
  trustCommand(input: McpTrustCommandInput): void
  /** App quit: closes every session (stdio children are stopped). */
  closeAll(): Promise<void>
}

export interface McpClientDeps {
  db: Db
  /** Receives every McpClientEvent (main forwards them to the renderer on 'mcp-client:event'). */
  emit(event: McpClientEvent): void
  /** HTTP/SSE transports; default the global (Node) fetch, like the HTTP pipeline. */
  fetchImpl?: typeof fetch
  /** Base environment for stdio children instead of the SDK's getDefaultEnvironment() (tests; the SDK still adds its safe defaults underneath). */
  spawnEnv?: NodeJS.ProcessEnv
  /** Clock in ms (tests). */
  now?: () => number
  /** Sent as the client's version in `initialize`. */
  appVersion?: string
  /**
   * Replaces secret values that the scripts of a session read with `{{name}}` (ScriptService.redact), for what History
   * records (like HttpService). Absent: recorded as given.
   */
  redact?: (sessionId: string | null | undefined, text: string) => string
}

/** The implementation (re-exported here so core.ts keeps importing the contract module only). */
export { McpClientService } from './service'
