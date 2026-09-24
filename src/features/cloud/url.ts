/** Small helpers for the server URL field. The main process validates again; this is instant feedback. */

export const DEFAULT_BASE_URL = 'https://api.slinger.app'

export const normalizeBaseUrl = (u: string) => u.trim().replace(/\/+$/, '')

export function isValidBaseUrl(u: string): boolean {
  try {
    const p = new URL(u.trim()).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** True for a plain-http URL that is not loopback: tokens and content would travel unencrypted. */
export function isInsecureRemote(u: string): boolean {
  try {
    const url = new URL(u.trim())
    return url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !url.hostname.endsWith('.localhost')
  } catch {
    return false
  }
}
