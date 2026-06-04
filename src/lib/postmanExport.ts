import type { ApiFolder, ApiRequest, Collection } from '../tauri'
import {
  ROOT_ID,
  groupFoldersByParent,
  groupRequestsByFolder,
} from './collectionTree'
import {
  parseDocument,
  requestHeaders,
  requestResponses,
  requestScripts,
  type HeaderDocument,
  type RequestDocument,
} from './requestDocument'

const POSTMAN_COLLECTION_SCHEMA =
  'https://schema.postman.com/json/collection/v2.1.0/collection.json'

type PostmanHeader = HeaderDocument & {
  key: string
  value: string
}

type PostmanQueryParam = {
  key: string | null
  value: string | null
  disabled?: boolean
  description?: unknown
}

type PostmanUrlVariable = {
  key: string
  value?: string
  description?: string
}

type PostmanUrl = {
  raw: string
  protocol?: string
  host?: string | string[]
  path?: string | string[]
  port?: string
  query?: PostmanQueryParam[]
  hash?: string
  variable?: PostmanUrlVariable[]
}

type PostmanRequest = {
  method: string
  header: PostmanHeader[]
  url: PostmanUrl
  description?: unknown
  body?: unknown
  auth?: unknown
}

type PostmanItem = {
  name: string
  item?: PostmanItem[]
  request?: PostmanRequest
  event?: unknown[]
  response?: unknown[]
}

type PostmanCollection = {
  info: {
    _postman_id: string
    name: string
    schema: string
  }
  item: PostmanItem[]
}

export type ExportPostmanCollectionInput = {
  collection: Collection
  folders: ApiFolder[]
  requests: ApiRequest[]
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

function splitUrlQuery(rawUrl: string): { base: string; queryText: string } {
  const hashIndex = rawUrl.indexOf('#')
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl
  const queryIndex = withoutHash.indexOf('?')

  if (queryIndex < 0) return { base: withoutHash, queryText: '' }

  return {
    base: withoutHash.slice(0, queryIndex),
    queryText: withoutHash.slice(queryIndex + 1),
  }
}

function parseQuery(queryText: string): PostmanQueryParam[] {
  if (!queryText) return []

  return queryText
    .split('&')
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf('=')
      const rawKey = separatorIndex >= 0 ? entry.slice(0, separatorIndex) : entry
      const rawValue = separatorIndex >= 0 ? entry.slice(separatorIndex + 1) : ''

      return {
        key: decodeUrlPart(rawKey),
        value: decodeUrlPart(rawValue),
      }
    })
}

function shouldParseHost(base: string, hasProtocol: boolean, hasProtocolSlashes: boolean): boolean {
  if (hasProtocol || hasProtocolSlashes) return true
  if (base.startsWith('/')) return false

  const firstSegment = base.split('/')[0] ?? ''
  return firstSegment.includes('.') || firstSegment.includes(':') || firstSegment.includes('{{')
}

function hostParts(host: string): string | string[] {
  if (!host) return []
  if (host.includes('{{') || host.includes(':')) return decodeUrlPart(host)
  return host.split('.').filter(Boolean).map(decodeUrlPart)
}

function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean).map(decodeUrlPart)
}

function postmanUrlVariables(document: RequestDocument): PostmanUrlVariable[] {
  const variables = document.source?.request?.url?.variable
  if (!Array.isArray(variables)) return []

  return variables
    .filter((variable): variable is PostmanUrlVariable => Boolean(variable.key?.trim()))
    .map((variable) => ({
      key: variable.key.trim(),
      value: variable.value,
      description: variable.description,
    }))
}

function postmanUrl(rawUrl: string, document: RequestDocument): PostmanUrl {
  const raw = rawUrl.trim()
  const url: PostmanUrl = { raw }
  const variables = postmanUrlVariables(document)

  if (variables.length > 0) {
    url.variable = variables
  }

  if (!raw) return url

  const hashIndex = raw.indexOf('#')
  const hash = hashIndex >= 0 ? raw.slice(hashIndex + 1) : ''
  const { base, queryText } = splitUrlQuery(raw)
  const query = parseQuery(queryText)
  if (query.length > 0) url.query = query
  if (hash) url.hash = hash

  const protocolMatch = base.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)
  const hasProtocol = Boolean(protocolMatch)
  const hasProtocolSlashes = base.startsWith('//')
  let workingBase = base

  if (protocolMatch) {
    url.protocol = protocolMatch[1]
    workingBase = base.slice(protocolMatch[0].length)
  } else if (hasProtocolSlashes) {
    workingBase = base.slice(2)
  }

  if (shouldParseHost(base, hasProtocol, hasProtocolSlashes)) {
    const slashIndex = workingBase.indexOf('/')
    const hostWithPort = slashIndex >= 0 ? workingBase.slice(0, slashIndex) : workingBase
    const path = slashIndex >= 0 ? workingBase.slice(slashIndex + 1) : ''
    let host = hostWithPort
    let port = ''
    const lastColonIndex = hostWithPort.lastIndexOf(':')
    const shouldSplitPort =
      lastColonIndex > 0 &&
      !hostWithPort.includes('{{') &&
      !hostWithPort.startsWith('[') &&
      /^\d+$/.test(hostWithPort.slice(lastColonIndex + 1))

    if (shouldSplitPort) {
      host = hostWithPort.slice(0, lastColonIndex)
      port = hostWithPort.slice(lastColonIndex + 1)
    }

    const hostValues = hostParts(host)
    const pathValues = pathParts(path)

    if (hostValues.length > 0) url.host = hostValues
    if (port) url.port = port
    if (pathValues.length > 0) url.path = pathValues
    return url
  }

  const pathValues = pathParts(workingBase.replace(/^\/+/, ''))
  if (pathValues.length > 0) url.path = pathValues

  return url
}

function postmanHeaders(headers: HeaderDocument[]): PostmanHeader[] {
  return headers
    .map((header) => {
      const looseHeader = header as HeaderDocument & Record<string, unknown>
      const key = typeof looseHeader.key === 'string' ? looseHeader.key.trim() : ''
      if (!key) return null

      const value =
        typeof looseHeader.value === 'string'
          ? looseHeader.value
          : looseHeader.value === undefined || looseHeader.value === null
            ? ''
            : String(looseHeader.value)

      return {
        ...looseHeader,
        key,
        value,
      }
    })
    .filter((header): header is PostmanHeader => header !== null)
}

function requestBody(document: RequestDocument): unknown | undefined {
  const body = (document as RequestDocument & { body?: unknown }).body
  return body === null ? undefined : body
}

function postmanRequestItem(request: ApiRequest): PostmanItem {
  const document = parseDocument(request)
  const method = (document.method ?? request.method ?? 'GET').trim().toUpperCase() || 'GET'
  const rawUrl = document.url ?? request.url ?? ''
  const postmanRequest: PostmanRequest = {
    method,
    header: postmanHeaders(requestHeaders(document)),
    url: postmanUrl(rawUrl, document),
  }
  const item: PostmanItem = {
    name: document.name?.trim() || request.name,
    request: postmanRequest,
  }
  const body = requestBody(document)
  const scripts = requestScripts(document)
  const responses = requestResponses(document)

  if (
    document.description !== null &&
    document.description !== undefined &&
    document.description !== ''
  ) {
    postmanRequest.description = document.description
  }
  if (body !== undefined) postmanRequest.body = body
  if (document.auth !== null && document.auth !== undefined) postmanRequest.auth = document.auth
  if (scripts.length > 0) item.event = scripts
  if (responses.length > 0) item.response = responses

  return item
}

export function buildPostmanCollection({
  collection,
  folders,
  requests,
}: ExportPostmanCollectionInput): PostmanCollection {
  const foldersByParent = groupFoldersByParent(folders)
  const requestsByFolder = groupRequestsByFolder(requests)

  function itemsForParent(parentFolderId: string): PostmanItem[] {
    const folderItems = (foldersByParent.get(parentFolderId) ?? []).map((folder) => ({
      name: folder.name,
      item: itemsForParent(folder.id),
    }))
    const requestItems = (requestsByFolder.get(parentFolderId) ?? []).map(postmanRequestItem)

    return [...folderItems, ...requestItems]
  }

  return {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      schema: POSTMAN_COLLECTION_SCHEMA,
    },
    item: itemsForParent(ROOT_ID),
  }
}

export function exportPostmanCollection(input: ExportPostmanCollectionInput): string {
  const postmanCollection = buildPostmanCollection(input)
  return JSON.stringify(postmanCollection, null, 2)
}
