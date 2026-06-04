export type BuiltinVariable = {
  name: string
  description: string
  preview: string
}

export const BUILTIN_VARIABLES: BuiltinVariable[] = [
  {
    name: 'randomUUID',
    description: 'Random UUID v4',
    preview: '7b9f4c6e-2a62-4f29-a97f-36a2f61c24d2',
  },
  {
    name: 'timestamp',
    description: 'Unix timestamp in seconds',
    preview: '1717432480',
  },
  {
    name: 'isoTimestamp',
    description: 'Current ISO timestamp',
    preview: '2026-06-03T16:00:00.000Z',
  },
  {
    name: 'date',
    description: 'Current UTC date',
    preview: '2026-06-03',
  },
  {
    name: 'time',
    description: 'Current UTC time',
    preview: '16:00:00',
  },
  {
    name: 'randomInt',
    description: 'Random integer from 0 to 999999',
    preview: '482391',
  },
  {
    name: 'randomString',
    description: 'Random alphanumeric string',
    preview: 'k9x2qp7m',
  },
  {
    name: 'randomBoolean',
    description: 'Random true or false',
    preview: 'true',
  },
  {
    name: 'randomEmail',
    description: 'Random example email',
    preview: 'user_42@example.com',
  },
]

const BUILTIN_VARIABLE_NAMES = new Set(BUILTIN_VARIABLES.map((variable) => variable.name))

export function normalizeBuiltinVariableName(name: string): string {
  return name.trim().replace(/^\$/, '')
}

function randomString(length = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let value = ''

  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)]
  }

  return value
}

function randomUUID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (part) => {
    const random = Math.floor(Math.random() * 16)
    const value = part === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

export function builtinVariableToken(name: string): string {
  return `{{${'$'}${normalizeBuiltinVariableName(name)}}}`
}

export function isBuiltinVariable(name: string): boolean {
  return BUILTIN_VARIABLE_NAMES.has(normalizeBuiltinVariableName(name))
}

export function builtinVariableSuggestions(query: string): BuiltinVariable[] {
  const normalizedQuery = normalizeBuiltinVariableName(query).toLowerCase()

  if (!normalizedQuery) return BUILTIN_VARIABLES

  return BUILTIN_VARIABLES.filter((variable) =>
    variable.name.toLowerCase().includes(normalizedQuery),
  )
}

export function resolveBuiltinVariable(name: string, now = new Date()): string | null {
  switch (normalizeBuiltinVariableName(name)) {
    case 'randomUUID':
      return randomUUID()
    case 'timestamp':
      return Math.floor(now.getTime() / 1000).toString()
    case 'isoTimestamp':
      return now.toISOString()
    case 'date':
      return now.toISOString().slice(0, 10)
    case 'time':
      return now.toISOString().slice(11, 19)
    case 'randomInt':
      return Math.floor(Math.random() * 1_000_000).toString()
    case 'randomString':
      return randomString()
    case 'randomBoolean':
      return Math.random() >= 0.5 ? 'true' : 'false'
    case 'randomEmail':
      return `user_${randomString(8).toLowerCase()}@example.com`
    default:
      return null
  }
}

export function previewBuiltinVariable(name: string): string | null {
  const normalizedName = normalizeBuiltinVariableName(name)
  return BUILTIN_VARIABLES.find((variable) => variable.name === normalizedName)?.preview ?? null
}
