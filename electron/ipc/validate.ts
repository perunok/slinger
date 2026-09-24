import { z } from 'zod'
import { invalidInput } from '../lib/errors'

/** Parses `args` against a tuple schema and turns zod failures into invalid_input errors. */
export function parseArgs<T extends z.ZodType>(schema: T, args: unknown[]): z.infer<T> {
  const result = schema.safeParse(args)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = issues[0]
    throw invalidInput(`Invalid input${first ? ` (${first.path || 'argument'}: ${first.message})` : ''}`, { issues })
  }
  return result.data
}
