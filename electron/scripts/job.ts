/**
 * Messages between the ScriptService (main thread) and the sandbox runner (worker thread, or inline in tests).
 * Everything here is structured-clone safe plain data.
 */
import type {
  ResolvedAuth,
  ResolvedBody,
  RequestHeader,
  ScriptConsoleEntry,
  ScriptErrorInfo,
  ScriptEventName,
  ScriptRequestData,
  ScriptResponseData,
  ScriptSource,
  ScriptTestResult,
  ScriptVariables,
} from '../../shared/types'

/** Resource limits of one script (each script of a chain gets a fresh runtime with these limits). */
export interface ScriptLimits {
  /** Wall-clock budget per script, enforced by the QuickJS interrupt handler. */
  timeoutMs: number
  /** QuickJS heap limit per script. */
  memoryBytes: number
  /** QuickJS stack limit per script. */
  stackBytes: number
  /** Total console text kept per run; later output is dropped with one notice. */
  consoleBytes: number
  consoleEntries: number
  /** Longest single console message (longer ones are cut). */
  messageChars: number
  tests: number
  /** Most pm.sendRequest calls per script run. */
  maxSendRequests: number
  /** Default per-call pm.sendRequest timeout (a call's own `timeout` may lower it, never raise it). */
  sendRequestTimeoutMs: number
  /**
   * Wall-clock cap of one script including time spent waiting for pm.sendRequest responses. `timeoutMs` counts
   * only the time the script itself runs, so a slow token endpoint does not eat the script's CPU budget.
   */
  wallClockMs: number
}

/** Upper bound of ScriptLimits.wallClockMs. */
export const MAX_SCRIPT_WALL_CLOCK_MS = 5 * 60_000
/** Upper bound of ScriptLimits.sendRequestTimeoutMs. */
export const MAX_SEND_REQUEST_TIMEOUT_MS = 120_000
export const MAX_SEND_REQUESTS = 20

export const DEFAULT_LIMITS: ScriptLimits = {
  timeoutMs: 5000,
  memoryBytes: 64 * 1024 * 1024,
  // QuickJS counts its own stack; keep it well below V8's native stack for the wasm frames (overflowing that
  // would abort the whole module instead of raising a catchable "stack overflow" InternalError).
  stackBytes: 256 * 1024,
  consoleBytes: 512 * 1024,
  consoleEntries: 1000,
  messageChars: 10_000,
  tests: 1000,
  maxSendRequests: MAX_SEND_REQUESTS,
  sendRequestTimeoutMs: 60_000,
  wallClockMs: MAX_SCRIPT_WALL_CLOCK_MS,
}

/** Largest value a script may store in any variable scope (matches the environment variable limit). */
export const MAX_VALUE_CHARS = 1_000_000
/** Largest response body handed to test scripts (pm.response.text()). */
export const MAX_RESPONSE_BODY_CHARS = 8 * 1024 * 1024

/** Active environment as the sandbox sees it. Secret values are NOT included; they are read on demand. */
export interface EnvSnapshot {
  name: string
  variables: Array<{ id: string; key: string; value: string | null; secret: boolean }>
}

export type EnvOp = { op: 'set'; key: string; value: string } | { op: 'unset'; key: string }

export interface ScriptJob {
  event: ScriptEventName
  scripts: ScriptSource[]
  request: ScriptRequestData
  response: ScriptResponseData | null
  variables: ScriptVariables
  collectionVariables: ScriptVariables
  globals: ScriptVariables
  info: { requestName: string; requestId: string | null; iteration: number; iterationCount: number }
  /** null when no environment is active: pm.environment writes then last for this run only. */
  environment: EnvSnapshot | null
  /** Synced workspace with the viewer role: pm.environment.set/unset throw inside the script. */
  readOnly: boolean
  /** Pre-request chains stop at the first failing script unless this is set. */
  continueOnError: boolean
  limits: ScriptLimits
}

export interface ScriptJobResult {
  errors: ScriptErrorInfo[]
  request: ScriptRequestData | null
  variables: ScriptVariables
  collectionVariables: ScriptVariables
  globals: ScriptVariables
  envOps: EnvOp[]
  console: ScriptConsoleEntry[]
  tests: ScriptTestResult[]
  durationMs: number
}

/**
 * One pm.sendRequest, already validated and with `{{variables}}` resolved by the sandbox host; the main process
 * runs it with the regular HTTP engine (executeHttp) and the session's file grants.
 */
export interface SendRequestCall {
  method: string
  url: string
  headers: RequestHeader[]
  auth: ResolvedAuth
  body: ResolvedBody
  timeoutMs: number
}

/** What a script sees of a pm.sendRequest response (body already decoded and capped). */
export interface SendRequestResponse {
  code: number
  status: string
  headers: RequestHeader[]
  body: string
  truncated: boolean
  responseTime: number
  size: number
}

/** Never a rejection: network failures come back as `ok: false`. `logLine` is redacted for the script console. */
export type SendRequestOutcome = { ok: true; response: SendRequestResponse; logLine: string } | { ok: false; error: string; logLine: string }

/** What the runner needs from its host thread. */
export interface ScriptRunnerDeps {
  /** Reads a secret variable's value (keychain, via the main thread). null when missing. */
  readSecret(variableId: string): string | null
  /** True once the run was cancelled (checked by the interrupt handler). */
  isCancelled(): boolean
  /** Runs one pm.sendRequest (main process). Absent: pm.sendRequest reports that it is unavailable. */
  sendHttp?(call: SendRequestCall, signal: AbortSignal): Promise<SendRequestOutcome>
  now?: () => number
}
