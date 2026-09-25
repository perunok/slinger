/**
 * Messages between the ScriptService (main thread) and the sandbox runner (worker thread, or inline in tests).
 * Everything here is structured-clone safe plain data.
 */
import type {
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
}

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

/** What the runner needs from its host thread. */
export interface ScriptRunnerDeps {
  /** Reads a secret variable's value (keychain, via the main thread). null when missing. */
  readSecret(variableId: string): string | null
  /** True once the run was cancelled (checked by the interrupt handler). */
  isCancelled(): boolean
  now?: () => number
}
