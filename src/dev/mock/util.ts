import { IpcError, type DescriptionType, type IpcErrorPayload } from '../../../shared/types'

export const nowSec = (): number => Math.floor(Date.now() / 1000)

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Deep clone of JSON-compatible data (everything crossing the mock boundary is JSON-shaped). */
export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

export function fail(code: IpcErrorPayload['code'], message: string, details?: Record<string, unknown>): never {
  throw new IpcError({ code, message, details })
}

export function cleanName(name: string, what: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) fail('invalid_input', `${what} name must not be empty`)
  return trimmed
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Sort key for "ordered by sortOrder, then createdAt, id" lists. */
export function bySortOrder<T extends { sortOrder: number; createdAt: number; id: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Same rules as the main process (repositories/common.ts cleanScriptsJson): null or a JSON array; [] -> null. */
export function cleanScriptsJson(value: string | null): string | null {
  if (value === null || value === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('invalid_input', 'scriptsJson must be valid JSON')
  }
  if (!Array.isArray(parsed)) fail('invalid_input', 'scriptsJson must be a JSON array (Postman "event" list)')
  return parsed.length === 0 ? null : value
}

/** Same rules as the main process (repositories setDescription): blank clears text and type; the type is kept otherwise. */
export function setDescription(row: { description?: string | null; descriptionType?: DescriptionType | null }, value: string | null): void {
  if (value !== null && typeof value !== 'string') fail('invalid_input', 'description must be a string or null')
  const clean = value === null || value.trim() === '' ? null : value
  row.description = clean
  if (clean === null) row.descriptionType = null
  else row.descriptionType ??= null
}
