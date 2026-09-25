/**
 * In-memory implementation of the whole SlingerIpcApi for running the renderer in a plain browser.
 * `installMockBackend()` sets `window.slinger` (when undefined) and `window.__slingerMock`.
 */
import { createSyncApi, type CloudOptions, type MockCloudControls } from './mock/sync'
import { IPC_CHANNELS, type SlingerIpcApi } from '../../shared/ipc-contract'
import { IpcError, type IpcErrorPayload } from '../../shared/types'
import { createHttpApi } from './mock/http'
import { createScriptsApi } from './mock/scripts'
import { createMiscApi } from './mock/misc'
import { importPostman, replaceFromPostman } from './mock/postmanImport'
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
  /** Scripts the cloud side: sign-in approval, remote edits, roles, offline, auth expiry, conflicts. */
  cloud: MockCloudControls
  calls: MockCall[]
}

export interface MockOptions {
  latencyMs?: number
  seed?: boolean
  cloud?: CloudOptions
}

declare global {
  interface Window {
    __slingerMock?: MockControls
  }
}

const CALL_LOG_CAP = 500
/** These must start synchronously (cancel has to find the run); executeHttpRequest simulates its own timing. */
const NO_LATENCY = new Set<string>(['executeHttpRequest', 'cancelHttpRequest'])

/**
 * The real preload rejects with a PLAIN object (contextBridge strips Error subclass fields),
 * so the mock does too: `{name:'IpcError', code, message, details}` — never an Error instance.
 */
function toPlain(e: unknown): IpcErrorPayload & { name: 'IpcError' } {
  if (e instanceof IpcError) return { name: 'IpcError', code: e.code, message: e.message, details: e.details }
  return { name: 'IpcError', code: 'internal_error', message: e instanceof Error ? e.message : String(e) }
}

function toError(error: Partial<IpcErrorPayload> | undefined, method: string): IpcErrorPayload & { name: 'IpcError' } {
  return {
    name: 'IpcError',
    code: error?.code ?? 'internal_error',
    message: error?.message ?? `Injected failure in ${method}`,
    details: error?.details,
  }
}

export function createMockBackend(options: MockOptions = {}): SlingerIpcApi & MockControls {
  const state: MockState = emptyState()
  let latency = options.latencyMs ?? 25
  const seed = options.seed !== false
  const once = new Map<string, Partial<IpcErrorPayload>>()
  let always: { method: string; error?: Partial<IpcErrorPayload> } | null = null
  const calls: MockCall[] = []

  const misc = createMiscApi()
  const sync = createSyncApi(state, options.cloud)
  const impl: SlingerIpcApi = {
    ...createWorkspaceApi(state),
    ...createTreeApi(state),
    ...createVersionApi(state),
    ...createHttpApi(state),
    ...createScriptsApi(),
    ...misc,
    ...sync.api,
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
    async importPostmanCollection(workspaceId, fileContents, options) {
      return importPostman(state, workspaceId, fileContents, options)
    },
    async replaceCollectionFromPostman(collectionId, fileContents, sourceName) {
      return replaceFromPostman(state, collectionId, fileContents, sourceName)
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
      const run = () => {
        // Cloud sync: viewer workspaces reject writes (like the main-process triggers); linked workspaces get status/auto-sync.
        let target: string | null = null
        try {
          target = sync.beforeWrite(method, clone(args))
        } catch (e) {
          return Promise.reject(toPlain(e))
        }
        return fn(...clone(args)).then(
          (r) => {
            sync.afterWrite(target)
            return clone(r)
          },
          (e: unknown) => {
            throw toPlain(e)
          },
        )
      }
      return NO_LATENCY.has(method) ? run() : sleep(latency).then(run)
    }
  }

  const api = {} as Record<string, unknown>
  for (const channel of IPC_CHANNELS) api[channel] = wrap(channel)
  api.onSyncEvent = impl.onSyncEvent

  const controls: MockControls = {
    reset() {
      Object.assign(state, emptyState())
      if (seed) seedState(state)
      misc.resetSecureStore()
      sync.reset()
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
    cloud: sync.controls,
    calls,
  }
  controls.reset()
  return Object.assign(api, controls) as unknown as SlingerIpcApi & MockControls
}

export function installMockBackend(): void {
  if (typeof window === 'undefined') return
  // In the browser the device sign-in approves itself after a moment, and edits auto-sync with a short debounce.
  // `?mockLatency=<ms>` slows every call down, e.g. to look at the launch skeleton.
  const latencyMs = Number(new URLSearchParams(location.search).get('mockLatency')) || undefined
  const backend = createMockBackend({ latencyMs, cloud: { autoApproveMs: 2500, autoCycleMs: 1500, stepMs: 250 } })
  window.__slingerMock = backend
  if (window.slinger === undefined) window.slinger = backend
}
