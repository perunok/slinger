import { invalidInput } from './errors'

/** Trims and validates a user-visible name. */
export function cleanName(value: unknown, label = 'name', max = 200): string {
  if (typeof value !== 'string') throw invalidInput(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw invalidInput(`${label} is required`)
  if (trimmed.length > max) throw invalidInput(`${label} must be at most ${max} characters`)
  return trimmed
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function cleanMethod(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('method must be a string')
  const method = value.trim().toUpperCase()
  if (!method) throw invalidInput('method is required')
  if (method.length > 32 || !HTTP_TOKEN.test(method)) throw invalidInput('method is not a valid HTTP token')
  return method
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)
