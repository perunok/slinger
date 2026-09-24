import { IpcError } from '../../shared/types'
import type { IpcErrorPayload } from '../../shared/types'

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
  return { code: 'internal_error', message }
}
