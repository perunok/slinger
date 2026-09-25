import { invalidInput } from '../lib/errors'

/** Only plain web URLs may be handed to the OS; file:, javascript:, custom schemes etc. are refused. */
export function assertExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidInput('url is required')
  if (value.length > 8192) throw invalidInput('url is too long')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw invalidInput('url is not valid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidInput('only http and https URLs can be opened')
  }
  return url.toString()
}
