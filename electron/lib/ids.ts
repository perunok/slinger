import { v7 as uuidv7 } from 'uuid'
import { invalidInput } from './errors'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const newId = (): string => uuidv7()

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value)

/**
 * Every id that reaches a query or a filesystem path goes through this first.
 * Returns the canonical lower-case form.
 */
export function assertUuid(value: unknown, label = 'id'): string {
  if (!isUuid(value)) throw invalidInput(`${label} must be a valid UUID`)
  return value.toLowerCase()
}
