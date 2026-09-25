/** Thin helpers around `window.slinger`: error normalisation and toast-reporting wrappers. */
import type { SlingerIpcApi } from '../../shared/ipc-contract'
import type { IpcErrorPayload } from '../../shared/types'
import { toast } from '../app/toast.svelte'

export function api(): SlingerIpcApi {
  return window.slinger
}

export interface ErrorInfo {
  code?: IpcErrorPayload['code']
  message: string
  details?: Record<string, unknown>
}

const CODES = ['not_found', 'version_conflict', 'invalid_input', 'io_error', 'network_error', 'internal_error', 'read_only', 'unauthenticated', 'sync_blocked'] as const

/** Shown for every mutation rejected because the workspace is a read-only (viewer) cloud workspace. */
export const READ_ONLY_MESSAGE = 'This workspace is read-only (viewer access). Ask an owner for editor access, or unlink it to work on a local copy.'

/** Normalises anything thrown by IPC (real IpcError, Electron-wrapped Error, string) into one shape. */
export function errorInfo(e: unknown): ErrorInfo {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown; details?: unknown }
    const message = typeof o.message === 'string' ? o.message : String(e)
    let code = CODES.find((c) => c === o.code)
    if (!code) code = CODES.find((c) => message.includes(c))
    // Electron prefixes: "Error invoking remote method 'x': IpcError: msg"
    const clean = message.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '')
    return { code, message: code === 'read_only' ? READ_ONLY_MESSAGE : clean, details: (o.details as Record<string, unknown> | undefined) ?? undefined }
  }
  return { message: String(e) }
}

export function isReadOnly(e: unknown): boolean {
  return errorInfo(e).code === 'read_only'
}

export function isVersionConflict(e: unknown): boolean {
  return errorInfo(e).code === 'version_conflict'
}

/**
 * Runs an IPC call; on failure shows an error toast (`what` describes the action) and returns undefined.
 * Use `tryIpc` from features that need the error to show inline instead.
 */
export async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    toast.error(`${what} failed`, errorInfo(e).message)
    return undefined
  }
}
