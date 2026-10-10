/**
 * MCP server settings and lifecycle. Settings (enabled, port) live in app_settings (local, never synced); the bearer
 * token lives in the secret store (OS keychain) and is created the first time the server is turned on.
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/database'
import type { SecretStore } from '../services/secrets'
import { getSetting, setSetting } from '../sync/store'
import { MCP_DEFAULT_PORT, type McpCallResult, type McpSettings, type McpStatus } from '../../shared/mcp'
import { McpBridge, type McpEmit } from './bridge'
import { McpHttpServer } from './server'

const SETTINGS_KEY = 'mcp'
export const MCP_TOKEN_KEY = 'mcp.token'

export interface McpServiceDeps {
  db: Db
  secrets: SecretStore
  /** Push a tool call to the renderer; false when there is no window. */
  emit: McpEmit
  appVersion: string
  /** How a client starts the stdio bridge (Slinger's own executable in Node mode + the bundled bridge script). */
  stdioCommand: { command: string; args: string[] }
  now?: () => number
}

export class McpService {
  readonly bridge: McpBridge
  readonly #server: McpHttpServer
  #error: string | null = null
  #lastCallAt: number | null = null
  #calls = 0

  constructor(private readonly deps: McpServiceDeps) {
    this.bridge = new McpBridge(deps.emit)
    this.#server = new McpHttpServer({
      run: (tool, args, timeoutMs) => this.bridge.call(tool, args, timeoutMs),
      token: () => this.#token(),
      appVersion: deps.appVersion,
      onCall: () => {
        this.#calls++
        this.#lastCallAt = Math.floor((deps.now ?? Date.now)() / 1000)
      },
    })
  }

  settings(): McpSettings {
    try {
      const raw = getSetting(this.deps.db, SETTINGS_KEY)
      const s = raw ? (JSON.parse(raw) as Partial<McpSettings>) : {}
      return { enabled: s.enabled === true, port: Number.isInteger(s.port) ? s.port! : MCP_DEFAULT_PORT }
    } catch {
      return { enabled: false, port: MCP_DEFAULT_PORT }
    }
  }

  status(): McpStatus {
    const s = this.settings()
    const port = this.#server.listening ? this.#server.port : s.port
    return {
      ...s,
      running: this.#server.listening,
      error: s.enabled ? this.#error : null,
      url: `http://127.0.0.1:${port}/mcp`,
      lastCallAt: this.#lastCallAt,
      calls: this.#calls,
      stdio: {
        ...this.deps.stdioCommand,
        env: { ELECTRON_RUN_AS_NODE: '1', SLINGER_MCP_URL: `http://127.0.0.1:${port}/mcp`, SLINGER_MCP_TOKEN: '<token>' },
      },
    }
  }

  /** Starts the endpoint when enabled (app start). Never throws: a failure shows up in status().error. */
  async init(): Promise<void> {
    if (this.settings().enabled) await this.#apply()
  }

  async update(next: McpSettings): Promise<McpStatus> {
    setSetting(this.deps.db, SETTINGS_KEY, JSON.stringify({ enabled: next.enabled, port: next.port }))
    await this.#apply()
    return this.status()
  }

  revealToken(): string {
    return this.#token()
  }

  /** A new token: every connected client has to be given the new one. */
  regenerateToken(): McpStatus {
    this.deps.secrets.set(MCP_TOKEN_KEY, newToken())
    return this.status()
  }

  respond(callId: string, result: McpCallResult): void {
    this.bridge.respond(callId, result)
  }

  async stop(): Promise<void> {
    this.bridge.failAll('Slinger is shutting down.')
    await this.#server.stop()
  }

  #token(): string {
    let t = this.deps.secrets.get(MCP_TOKEN_KEY)
    if (!t) {
      t = newToken()
      this.deps.secrets.set(MCP_TOKEN_KEY, t)
    }
    return t
  }

  async #apply(): Promise<void> {
    const s = this.settings()
    this.#error = null
    if (!s.enabled) {
      this.bridge.failAll('The MCP server was turned off in Slinger.')
      await this.#server.stop()
      return
    }
    this.#token() // make sure one exists before the first client connects
    if (this.#server.listening && this.#server.port === s.port) return
    try {
      await this.#server.start(s.port)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      this.#error =
        code === 'EADDRINUSE'
          ? `Port ${s.port} is already in use. Choose another port.`
          : code === 'EACCES'
            ? `Port ${s.port} is not allowed. Choose a port above 1024.`
            : `Could not start: ${(e as Error).message}`
    }
  }
}

const newToken = () => `slg_${randomBytes(32).toString('base64url')}`
