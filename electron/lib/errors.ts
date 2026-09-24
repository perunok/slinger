import { IpcError } from '../../shared/types'
import type { IpcErrorPayload } from '../../shared/types'

/** Message raised by the `sync_readonly_*` triggers; mapped to the `read_only` IPC error code. */
export const READ_ONLY_MARKER = 'slinger:read_only'

export { IpcError }
export type { IpcErrorPayload }

export const notFound = (what: string, details?: Record<string, unknown>) =>
  new IpcError({ code: 'not_found', message: `${what} not found`, details })

export const invalidInput = (message: string, details?: Record<string, unknown>) =>
  new IpcError({ code: 'invalid_input', message, details })

export const versionConflict = (message: string, details?: Record<string, unknown>) =>
  new IpcError({ code: 'version_conflict', message, details })

export const ioError = (message: string, details?: Record<string, unknown>) =>
  new IpcError({ code: 'io_error', message, details })

export const networkError = (message: string, details?: Record<string, unknown>) =>
  new IpcError({ code: 'network_error', message, details })

/** Normalizes anything thrown into the wire payload; unknown errors never leak stacks. */
export function toErrorPayload(err: unknown): IpcErrorPayload {
  if (err instanceof IpcError) {
    return { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
  }
  const message = err instanceof Error ? err.message : String(err)
  // SQLite triggers on read-only (viewer) cloud workspaces abort with this marker (see migration 0004).
  if (message.includes(READ_ONLY_MARKER)) {
    return { code: 'read_only', message: 'This workspace is read-only (viewer role); changes are not allowed' }
  }
  return { code: 'internal_error', message }
}
