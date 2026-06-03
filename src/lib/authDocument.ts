import type { HeaderDocument } from './requestDocument'

export type AuthMethod = 'noauth' | 'apikey' | 'bearer' | 'basic' | 'oauth2' | 'unsupported'
export type SupportedAuthMethod = Exclude<AuthMethod, 'unsupported'>
type AttributeAuthMethod = Exclude<SupportedAuthMethod, 'noauth'>
export type AuthLocation = 'header' | 'query'

export type AuthAttribute = {
  key?: string
  value?: string
  type?: string
}

export type RequestAuthDocument = {
  type?: SupportedAuthMethod | string
  apikey?: AuthAttribute[]
  bearer?: AuthAttribute[]
  basic?: AuthAttribute[]
  oauth2?: AuthAttribute[]
}

export type EditableAuth = {
  method: AuthMethod
  unsupportedType?: string
  apiKey: {
    key: string
    value: string
    location: AuthLocation
  }
  bearer: {
    token: string
  }
  basic: {
    username: string
    password: string
  }
  oauth2: {
    accessToken: string
    tokenType: string
  }
}

export type AuthQueryParam = {
  key: string
  value: string
}

const SUPPORTED_AUTH_METHODS = new Set<SupportedAuthMethod>([
  'noauth',
  'apikey',
  'bearer',
  'basic',
  'oauth2',
])

const DEFAULT_AUTH: EditableAuth = {
  method: 'noauth',
  apiKey: {
    key: '',
    value: '',
    location: 'header',
  },
  bearer: {
    token: '',
  },
  basic: {
    username: '',
    password: '',
  },
  oauth2: {
    accessToken: '',
    tokenType: 'Bearer',
  },
}

function cloneDefaultAuth(): EditableAuth {
  return {
    method: DEFAULT_AUTH.method,
    apiKey: { ...DEFAULT_AUTH.apiKey },
    bearer: { ...DEFAULT_AUTH.bearer },
    basic: { ...DEFAULT_AUTH.basic },
    oauth2: { ...DEFAULT_AUTH.oauth2 },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function authAttributes(auth: RequestAuthDocument, method: AttributeAuthMethod): AuthAttribute[] {
  const values = auth[method]
  return Array.isArray(values) ? values : []
}

function authValue(
  auth: RequestAuthDocument,
  method: AttributeAuthMethod,
  key: string,
  fallback = '',
): string {
  const attribute = authAttributes(auth, method).find((item) => item.key === key)
  const value = attribute?.value
  return value === undefined || value === null ? fallback : String(value)
}

function normalizeAuthMethod(value: unknown): AuthMethod {
  if (typeof value !== 'string') return 'noauth'

  const method = value.trim().toLowerCase()
  return SUPPORTED_AUTH_METHODS.has(method as SupportedAuthMethod)
    ? (method as SupportedAuthMethod)
    : 'unsupported'
}

export function normalizeRequestAuth(auth: unknown): EditableAuth {
  const editable = cloneDefaultAuth()
  if (!isRecord(auth)) return editable

  const method = normalizeAuthMethod(auth.type)
  const document = auth as RequestAuthDocument
  editable.method = method

  if (method === 'unsupported') {
    editable.unsupportedType = typeof auth.type === 'string' ? auth.type : 'custom'
    return editable
  }

  editable.apiKey = {
    key: authValue(document, 'apikey', 'key'),
    value: authValue(document, 'apikey', 'value'),
    location: authValue(document, 'apikey', 'in', 'header') === 'query' ? 'query' : 'header',
  }
  editable.bearer = {
    token: authValue(document, 'bearer', 'token'),
  }
  editable.basic = {
    username: authValue(document, 'basic', 'username'),
    password: authValue(document, 'basic', 'password'),
  }
  editable.oauth2 = {
    accessToken: authValue(document, 'oauth2', 'accessToken'),
    tokenType: authValue(document, 'oauth2', 'tokenType', 'Bearer') || 'Bearer',
  }

  return editable
}

function authAttribute(key: string, value: string): AuthAttribute {
  return {
    key,
    value,
    type: 'string',
  }
}

export function authDocumentFromEditable(auth: EditableAuth): RequestAuthDocument | null {
  switch (auth.method) {
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          authAttribute('key', auth.apiKey.key),
          authAttribute('value', auth.apiKey.value),
          authAttribute('in', auth.apiKey.location),
        ],
      }
    case 'bearer':
      return {
        type: 'bearer',
        bearer: [authAttribute('token', auth.bearer.token)],
      }
    case 'basic':
      return {
        type: 'basic',
        basic: [
          authAttribute('username', auth.basic.username),
          authAttribute('password', auth.basic.password),
        ],
      }
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: [
          authAttribute('accessToken', auth.oauth2.accessToken),
          authAttribute('tokenType', auth.oauth2.tokenType || 'Bearer'),
        ],
      }
    case 'unsupported':
    case 'noauth':
    default:
      return null
  }
}

export function requestAuthsAreEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeRequestAuth(left)) === JSON.stringify(normalizeRequestAuth(right))
}

export function requestAuthTemplateValues(auth: unknown): string[] {
  const editable = normalizeRequestAuth(auth)

  switch (editable.method) {
    case 'apikey':
      return [editable.apiKey.key, editable.apiKey.value]
    case 'bearer':
      return [editable.bearer.token]
    case 'basic':
      return [editable.basic.username, editable.basic.password]
    case 'oauth2':
      return [editable.oauth2.accessToken, editable.oauth2.tokenType]
    case 'unsupported':
    case 'noauth':
    default:
      return []
  }
}

export function requestAuthParts(
  auth: unknown,
  resolveValue: (value: string) => string,
  encodeBasicAuth: (value: string) => string,
): {
  headers: HeaderDocument[]
  queryParams: AuthQueryParam[]
} {
  const editable = normalizeRequestAuth(auth)

  switch (editable.method) {
    case 'apikey': {
      const key = resolveValue(editable.apiKey.key).trim()
      const value = resolveValue(editable.apiKey.value)
      if (!key) return { headers: [], queryParams: [] }

      return editable.apiKey.location === 'query'
        ? { headers: [], queryParams: [{ key, value }] }
        : { headers: [{ key, value }], queryParams: [] }
    }
    case 'bearer': {
      const token = resolveValue(editable.bearer.token).trim()
      return token
        ? { headers: [{ key: 'Authorization', value: `Bearer ${token}` }], queryParams: [] }
        : { headers: [], queryParams: [] }
    }
    case 'basic': {
      const username = resolveValue(editable.basic.username)
      const password = resolveValue(editable.basic.password)
      if (!username && !password) return { headers: [], queryParams: [] }

      return {
        headers: [{ key: 'Authorization', value: `Basic ${encodeBasicAuth(`${username}:${password}`)}` }],
        queryParams: [],
      }
    }
    case 'oauth2': {
      const accessToken = resolveValue(editable.oauth2.accessToken).trim()
      const tokenType = resolveValue(editable.oauth2.tokenType).trim() || 'Bearer'
      return accessToken
        ? { headers: [{ key: 'Authorization', value: `${tokenType} ${accessToken}` }], queryParams: [] }
        : { headers: [], queryParams: [] }
    }
    case 'unsupported':
    case 'noauth':
    default:
      return { headers: [], queryParams: [] }
  }
}
