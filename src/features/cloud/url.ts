/** Small helpers for the server URL field. The main process validates again; this is instant feedback. */
import { withDefaultScheme } from '../../../shared/urlScheme'

export const DEFAULT_BASE_URL = 'https://api.slinger.app'

export const normalizeBaseUrl = (u: string) => withDefaultScheme(u).replace(/\/+$/, '')

export function isValidBaseUrl(u: string): boolean {
  try {
    // Typed without a scheme (`172.16.0.236:8088`): http, as main stores it.
    const p = new URL(withDefaultScheme(u)).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** True for a plain-http URL that is not loopback: tokens and content would travel unencrypted. */
export function isInsecureRemote(u: string): boolean {
  try {
    const url = new URL(withDefaultScheme(u))
    return url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !url.hostname.endsWith('.localhost')
  } catch {
    return false
  }
}
