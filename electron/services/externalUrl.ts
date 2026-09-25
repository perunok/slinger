import { invalidInput } from '../lib/errors'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Only plain web URLs (and mailto: links from documentation) may be handed to the OS; file:, javascript:,
 * data:, custom schemes etc. are refused.
 */
export function assertExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidInput('url is required')
  if (value.length > 8192) throw invalidInput('url is too long')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw invalidInput('url is not valid')
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw invalidInput('only http, https and mailto URLs can be opened')
  }
  return url.toString()
}
