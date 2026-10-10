/**
 * MCP server settings and lifecycle. Settings (enabled, port) live in app_settings (local, never synced); the bearer
 * token lives in the secret store (OS keychain) and is created the first time the server is turned on. While the server
 * runs, <userData>/mcp/endpoint.json holds its URL + token for the bridge connected assistants start (files.ts).
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/database'
import { IpcError } from '../lib/errors'
import type { SecretStore } from '../services/secrets'
import { getSetting, setSetting } from '../sync/store'
import { MCP_DEFAULT_PORT, type McpCallResult, type McpClientId, type McpClientStatus, type McpSettings, type McpStatus, type McpToolName } from '../../shared/mcp'
import { McpBridge, type McpEmit } from './bridge'
import { ClientConfigError, connectClient, disconnectClient, listClients, type ClientsEnv, type ServerEntry } from './clients'
import { McpFiles } from './files'
import { McpHttpServer } from './server'

const SETTINGS_KEY = 'mcp'
export const MCP_TOKEN_KEY = 'mcp.token'
/** A taken port falls back to one of the next ones. */
const PORT_TRIES = 10
/** Quitting: how long assistant calls in progress get to finish before they are answered with an error. */
export const QUIT_GRACE_MS = 10_000

export interface McpServiceDeps {
  db: Db
  secrets: SecretStore
  /** Push a tool call to the renderer; false when there is no window. */
  emit: McpEmit
  appVersion: string
  /** Slinger's data folder: <userData>/mcp holds the bridge, launch.json and endpoint.json. */
  userDataDir?: string
  /** dist-electron/mcp-stdio.cjs, copied to <userData>/mcp/bridge.cjs. */
  bridgeSource?: string | null
  /** The executable assistants run (in Node mode for the bridge; as the app to start Slinger). AppImage: the .AppImage file. */
  executable?: string
  /** Arguments that start the app (dev builds pass the app folder). */
  launchArgs?: string[]
  /** Extra environment for a Slinger started by the bridge (e.g. a non-default profile). */
  launchEnv?: Record<string, string>
  clientsEnv?: ClientsEnv
  /** How long a tool call waits for the window to be ready (it may just be starting). */
  hostReadyTimeoutMs?: number
  now?: () => number
}

export class McpService {
  readonly bridge: McpBridge
  readonly #server: McpHttpServer
  readonly #files: McpFiles | null
  #error: string | null = null
  #portNote: string | null = null
  #lastCallAt: number | null = null
  #calls = 0
  #hostReady = false
  #hostWaiters: Array<(ready: boolean) => void> = []
  #stopping = false

  constructor(private readonly deps: McpServiceDeps) {
    this.bridge = new McpBridge(deps.emit)
    this.#files = deps.userDataDir ? new McpFiles(deps.userDataDir) : null
    this.#server = new McpHttpServer({
      run: (tool, args, timeoutMs) => this.#run(tool, args, timeoutMs),
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

  /** The command connected assistants run (no secrets). */
  stdioEntry(): ServerEntry {
    return {
      command: this.deps.executable ?? 'slinger',
      args: [this.#files?.bridgePath ?? 'bridge.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }

  status(): McpStatus {
    const s = this.settings()
    const port = this.#server.listening ? this.#server.port : s.port
    return {
      ...s,
      running: this.#server.listening,
      error: s.enabled ? this.#error : null,
      portNote: this.#server.listening ? this.#portNote : null,
      url: `http://127.0.0.1:${port}/mcp`,
      lastCallAt: this.#lastCallAt,
      calls: this.#calls,
      stdio: this.stdioEntry(),
    }
  }

  /** App start: refreshes the bridge folder, then starts the endpoint when enabled. Never throws. */
  async init(): Promise<void> {
    this.#files?.prepare(this.deps.bridgeSource ?? null, this.#launch())
    if (this.settings().enabled) await this.#apply()
    else this.#files?.removeEndpoint()
  }

  async update(next: McpSettings): Promise<McpStatus> {
    this.#stopping = false
    setSetting(this.deps.db, SETTINGS_KEY, JSON.stringify({ enabled: next.enabled, port: next.port }))
    this.#files?.writeLaunch(this.#launch())
    await this.#apply()
    return this.status()
  }

  revealToken(): string {
    return this.#token()
  }

  /** A new token: assistants set up by hand need the new one; connected ones read it from endpoint.json. */
  regenerateToken(): McpStatus {
    this.deps.secrets.set(MCP_TOKEN_KEY, newToken())
    if (this.#server.listening) this.#files?.writeEndpoint({ url: this.status().url, token: this.#token() })
    return this.status()
  }

  respond(callId: string, result: McpCallResult): void {
    this.bridge.respond(callId, result)
  }

  /** The window's MCP host subscribed: calls can run. */
  hostReady(): void {
    this.#hostReady = true
    for (const w of this.#hostWaiters.splice(0)) w(true)
  }

  /** The window is (re)loading or gone. */
  hostGone(): void {
    this.#hostReady = false
  }

  async clients(): Promise<McpClientStatus[]> {
    if (!this.deps.clientsEnv) return []
    return listClients(this.deps.clientsEnv, this.stdioEntry())
  }

  /** Writes Slinger into the assistant's configuration, turning the server on first if needed. */
  async connect(id: McpClientId): Promise<McpClientStatus[]> {
    const env = this.deps.clientsEnv ?? fail('Connecting assistants is not available here.')
    const s = this.settings()
    if (!s.enabled) await this.update({ ...s, enabled: true })
    try {
      await connectClient(env, id, this.stdioEntry())
    } catch (e) {
      throw asIpcError(e)
    }
    return this.clients()
  }

  async disconnect(id: McpClientId): Promise<McpClientStatus[]> {
    const env = this.deps.clientsEnv ?? fail('Connecting assistants is not available here.')
    try {
      await disconnectClient(env, id)
    } catch (e) {
      throw asIpcError(e)
    }
    return this.clients()
  }

  /**
   * Slinger is quitting. Assistants stop finding the endpoint at once, new calls are refused, and calls in progress get
   * up to `graceMs` to finish (they run in the window, which stays alive meanwhile) before they are answered with an
   * error. Never throws.
   */
  async stop(graceMs = QUIT_GRACE_MS): Promise<void> {
    this.#stopping = true
    this.#files?.removeEndpoint()
    const failAll = () => {
      for (const w of this.#hostWaiters.splice(0)) w(false)
      this.bridge.failAll('Slinger is quitting.')
    }
    // Without a window nothing in progress can finish.
    if (!this.#hostReady) failAll()
    await this.#server.drain(this.#hostReady ? graceMs : 0, failAll).catch(() => this.#server.stop())
  }

  /**
   * The user quit Slinger (Quit in the tray or the menu, not a logout): connected assistants must not start it again
   * until it is opened by hand. launch.json is rewritten on every start, which clears this.
   */
  markQuit(): void {
    this.#files?.writeLaunch({ ...this.#launch(), quit: true })
  }

  async #run(tool: McpToolName, args: unknown, timeoutMs: number): Promise<McpCallResult> {
    if (this.#stopping) return { ok: false, error: 'Slinger is quitting.' }
    if (!this.#hostReady) {
      const ready = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), this.deps.hostReadyTimeoutMs ?? 30_000)
        this.#hostWaiters.push((r) => {
          clearTimeout(t)
          resolve(r)
        })
      })
      if (this.#stopping) return { ok: false, error: 'Slinger is quitting.' }
      if (!ready) return { ok: false, error: 'The Slinger window is not open (or still starting), so the tool cannot run. Open Slinger and try again.' }
    }
    return this.bridge.call(tool, args, timeoutMs)
  }

  #launch() {
    return {
      enabled: this.settings().enabled,
      command: this.deps.executable ?? 'slinger',
      args: this.deps.launchArgs ?? [],
      ...(this.deps.launchEnv && Object.keys(this.deps.launchEnv).length ? { env: this.deps.launchEnv } : {}),
    }
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
    this.#portNote = null
    if (!s.enabled) {
      this.bridge.failAll('The MCP server was turned off in Slinger.')
      this.#files?.removeEndpoint()
      await this.#server.stop()
      return
    }
    this.#token() // make sure one exists before the first client connects
    const preferred = s.port
    if (!(this.#server.listening && this.#server.port === preferred)) {
      let lastError: unknown = null
      let started = false
      // Port 0 (tests) means "any free port".
      for (let i = 0; i < (preferred === 0 ? 1 : PORT_TRIES); i++) {
        try {
          await this.#server.start(preferred === 0 ? 0 : preferred + i)
          started = true
          break
        } catch (e) {
          lastError = e
          if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') break
        }
      }
      if (!started) {
        const code = (lastError as NodeJS.ErrnoException | null)?.code
        this.#error =
          code === 'EADDRINUSE'
            ? `Ports ${preferred} to ${preferred + PORT_TRIES - 1} are all in use. Choose another port.`
            : code === 'EACCES'
              ? `Port ${preferred} is not allowed. Choose a port above 1024.`
              : `Could not start: ${(lastError as Error | null)?.message ?? 'unknown error'}`
        this.#files?.removeEndpoint()
        return
      }
    }
    if (preferred !== 0 && this.#server.port !== preferred) this.#portNote = `Port ${preferred} was busy, so ${this.#server.port} is used.`
    this.#files?.writeEndpoint({ url: `http://127.0.0.1:${this.#server.port}/mcp`, token: this.#token() })
  }
}

const newToken = () => `slg_${randomBytes(32).toString('base64url')}`

function fail(message: string): never {
  throw new IpcError({ code: 'invalid_input', message })
}

function asIpcError(e: unknown): Error {
  if (e instanceof IpcError) return e
  if (e instanceof ClientConfigError) return new IpcError({ code: 'io_error', message: e.message })
  return new IpcError({ code: 'io_error', message: `Could not change the assistant's settings: ${(e as Error).message}` })
}
