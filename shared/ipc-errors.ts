/**
 * ADDED (ts-rewrite main process): renderer-side helpers for errors coming through window.slinger.
 *
 * Electron's contextBridge drops custom properties (`code`, `details`) from Error objects, so the
 * preload script rejects with a plain object shaped like IpcErrorPayload plus `name: 'IpcError'`
 * instead. That object is NOT `instanceof Error` (and not `instanceof IpcError`): test with
 * isIpcErrorPayload() and read `.code` / `.message` / `.details`.
 */
import type { IpcErrorPayload } from './types'

export type IpcRejection = IpcErrorPayload & { name: 'IpcError' }

export function isIpcErrorPayload(value: unknown): value is IpcRejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'IpcError' &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

/** Best-effort human-readable message for any thrown value. */
export function errorMessage(value: unknown): string {
  if (isIpcErrorPayload(value)) return value.message
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  return 'Unexpected error'
}

/** True for the error a mutation gets when the workspace is a read-only (viewer) cloud workspace. */
export function isReadOnlyError(value: unknown): boolean {
  return isIpcErrorPayload(value) && value.code === 'read_only'
}
