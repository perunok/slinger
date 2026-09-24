/**
 * In-memory implementation of the whole SlingerIpcApi for running the renderer in a plain browser.
 * `installMockBackend()` sets `window.slinger` (when undefined) and `window.__slingerMock`.
 */
import { IPC_CHANNELS, type SlingerIpcApi } from '../../shared/ipc-contract'
import { IpcError, type IpcErrorPayload } from '../../shared/types'
import { createHttpApi } from './mock/http'
import { createMiscApi } from './mock/misc'
import { importPostman } from './mock/postmanImport'
import { seedState } from './mock/seed'
import { emptyState, type MockState } from './mock/store'
import { createTreeApi } from './mock/tree'
import { createVersionApi } from './mock/versions'
import { createWorkspaceApi } from './mock/workspaces'
import { clone, sleep } from './mock/util'

export interface MockCall {
  method: string
  args: unknown[]
}

export interface MockControls {
  reset(): void
  setLatency(ms: number): void
  /** The next call to `method` rejects once with this error. */
  failNext(method: keyof SlingerIpcApi, error?: Partial<IpcErrorPayload>): void
  /** Every call to `method` rejects until cleared with `failAlways(null)`. */
  failAlways(method: keyof SlingerIpcApi | null, error?: Partial<IpcErrorPayload>): void
  calls: MockCall[]
}

export interface MockOptions {
  latencyMs?: number
  seed?: boolean
}

declare global {
  interface Window {
    __slingerMock?: MockControls
  }
}

const CALL_LOG_CAP = 500
/** These must start synchronously (cancel has to find the run); executeHttpRequest simulates its own timing. */
const NO_LATENCY = new Set<string>(['executeHttpRequest', 'cancelHttpRequest'])

function toError(error: Partial<IpcErrorPayload> | undefined, method: string): IpcError {
  return new IpcError({
    code: error?.code ?? 'internal_error',
    message: error?.message ?? `Injected failure in ${method}`,
    details: error?.details,
  })
}

export function createMockBackend(options: MockOptions = {}): SlingerIpcApi & MockControls {
  const state: MockState = emptyState()
  let latency = options.latencyMs ?? 25
  const seed = options.seed !== false
  const once = new Map<string, Partial<IpcErrorPayload>>()
  let always: { method: string; error?: Partial<IpcErrorPayload> } | null = null
  const calls: MockCall[] = []

  const misc = createMiscApi()
  const impl: SlingerIpcApi = {
    ...createWorkspaceApi(state),
    ...createTreeApi(state),
    ...createVersionApi(state),
    ...createHttpApi(state),
    ...misc,
    async listHistory(workspaceId, limit) {
      const rows = state.history.filter((h) => h.workspaceId === workspaceId).sort((a, b) => b.createdAt - a.createdAt)
      return limit && limit > 0 ? rows.slice(0, limit) : rows
    },
    async clearHistory(workspaceId) {
      state.history = state.history.filter((h) => h.workspaceId !== workspaceId)
    },
    async deleteHistoryEntry(historyId) {
      state.history = state.history.filter((h) => h.id !== historyId)
    },
    async importPostmanCollection(workspaceId, fileContents) {
      return importPostman(state, workspaceId, fileContents)
    },
  }

  function wrap(method: keyof SlingerIpcApi): (...args: unknown[]) => Promise<unknown> {
    const fn = impl[method] as (...args: unknown[]) => Promise<unknown>
    return (...args) => {
      calls.push({ method, args: clone(args) })
      if (calls.length > CALL_LOG_CAP) calls.shift()
      const injected = once.get(method) ?? (always?.method === method ? (always.error ?? {}) : undefined)
      if (injected) {
        once.delete(method)
        return Promise.reject(toError(injected, method))
      }
      const run = () => fn(...clone(args)).then(clone)
      return NO_LATENCY.has(method) ? run() : sleep(latency).then(run)
    }
  }

  const api = {} as Record<string, unknown>
  for (const channel of IPC_CHANNELS) api[channel] = wrap(channel)

  const controls: MockControls = {
    reset() {
      Object.assign(state, emptyState())
      if (seed) seedState(state)
      misc.resetSecureStore()
      once.clear()
      always = null
      calls.length = 0
    },
    setLatency(ms) {
      latency = ms
    },
    failNext(method, error) {
      once.set(method, error ?? {})
    },
    failAlways(method, error) {
      always = method ? { method, error } : null
    },
    calls,
  }
  controls.reset()
  return Object.assign(api, controls) as unknown as SlingerIpcApi & MockControls
}

export function installMockBackend(): void {
  if (typeof window === 'undefined') return
  const backend = createMockBackend()
  window.__slingerMock = backend
  if (window.slinger === undefined) window.slinger = backend
}
