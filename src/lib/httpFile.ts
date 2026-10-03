/**
 * `.http` files (JetBrains HTTP Client, VS Code REST Client and others): a whole collection as one file, plus the
 * matching http-client.env.json / http-client.private.env.json.
 *
 * Built from the saved documents WITHOUT resolving anything: `{{variables}}` (built-ins too) stay as written, since these
 * clients use the same syntax and resolve them from their env files. So no variable value is written into the requests,
 * and the env files carry non-secret values only (secrets by name, with an empty value).
 */
import type { ApiFolder, ApiRequest, FormDataField, HttpRequestInput, ResolvedAuth, ResolvedBody } from '../../shared/types'
import { dataRows } from './kv'
import { normalizeUrl } from './prepare'
import { parseDocument, rawContentType, type RequestDraft } from './request'
import { generateSnippet, HTTP_OAUTH2_TOKEN_VARIABLE } from './snippets'
import type { TemplateScope } from './template'
import { buildTree, type TreeNode } from './tree'

export const HTTP_CLIENT_ENV_FILE = 'http-client.env.json'
export const HTTP_CLIENT_PRIVATE_ENV_FILE = 'http-client.private.env.json'
/** The environment name in the env files when no environment is active. */
export const HTTP_CLIENT_DEFAULT_ENV = 'default'

/**
 * The draft as an HttpRequestInput with every `{{template}}` kept verbatim. Lenient where sending is strict: a file
 * field or binary body without a file, an unsupported auth or body type is left out instead of failing the export.
 */
export function unresolvedInput(draft: RequestDraft, name = draft.name): HttpRequestInput {
  const url = draft.url.trim()
  const headers = dataRows(draft.headers)
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => ({ key: h.key.trim(), value: h.value }))

  const a = draft.auth
  const auth: ResolvedAuth = { kind: 'none' }
  if (a.kind === 'basic') {
    auth.kind = 'basic'
    auth.basic = { username: a.basic.username, password: a.basic.password }
  } else if (a.kind === 'bearer' && a.bearer.token.trim()) {
    auth.kind = 'bearer'
    auth.bearer = { token: a.bearer.token.trim() }
  } else if (a.kind === 'apiKey' && a.apiKey.key.trim()) {
    auth.kind = 'apiKey'
    auth.apiKey = { key: a.apiKey.key.trim(), value: a.apiKey.value, addTo: a.apiKey.addTo }
  } else if (a.kind === 'oauth2') {
    auth.kind = 'oauth2'
    auth.oauth2 = { tokenKey: '', addTo: a.oauth2.addTokenTo === 'queryParams' ? 'query' : 'header', headerPrefix: a.oauth2.headerPrefix.trim() }
  }

  const b = draft.body
  const body: ResolvedBody = { mode: 'none' }
  if (b.kind === 'raw') {
    body.mode = 'raw'
    body.raw = { content: b.raw, contentType: rawContentType(b.rawLanguage) }
  } else if (b.kind === 'urlEncoded') {
    body.mode = 'urlEncoded'
    body.urlEncoded = dataRows(b.urlEncoded)
      .filter((f) => f.enabled && f.key.trim())
      .map((f) => ({ key: f.key, value: f.value, enabled: true }))
  } else if (b.kind === 'formData') {
    body.mode = 'formData'
    body.formData = dataRows(b.formData)
      .filter((f) => f.enabled && f.key.trim() && (f.kind !== 'file' || f.filePath))
      .map((f): FormDataField =>
        f.kind === 'file' ? { key: f.key, value: '', type: 'file', filePath: f.filePath, enabled: true } : { key: f.key, value: f.value, type: 'text', enabled: true },
      )
  } else if (b.kind === 'binary' && b.binaryPath) {
    body.mode = 'binary'
    body.binaryFilePath = b.binaryPath
  }

  return {
    method: draft.method.toUpperCase(),
    // A URL starting with a variable ({{baseUrl}}/users) gets its scheme from the variable.
    url: url.startsWith('{{') ? url : normalizeUrl(url),
    headers,
    auth,
    body,
    requestName: name,
    workspaceId: '',
  }
}

export interface HttpFileExportInput {
  collectionName: string
  folders: ApiFolder[]
  requests: ApiRequest[]
}

export interface HttpFileExport {
  text: string
  /** True when a request uses OAuth 2.0, i.e. the file references `{{oauth2_access_token}}`. */
  usesOAuth2: boolean
}

/**
 * One `.http` file with every request in sidebar order, each a `### Folder / Sub folder / Request` block (the folder
 * path keeps names unique for "run by name" and shows where the request lives).
 */
export function exportHttpFile({ collectionName, folders, requests }: HttpFileExportInput): HttpFileExport {
  const blocks: string[] = []
  let usesOAuth2 = false
  const walk = (nodes: TreeNode[], path: string[]) => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        walk(n.children, [...path, n.folder.name])
        continue
      }
      const draft = parseDocument(n.request)
      if (draft.auth.kind === 'oauth2') usesOAuth2 = true
      const name = [...path, n.request.name].map((s) => s.trim()).filter(Boolean).join(' / ') || 'Untitled request'
      blocks.push(generateSnippet('http', unresolvedInput(draft, name)))
    }
  }
  walk(buildTree(folders, requests), [])
  const title = collectionName.replace(/[\r\n]+/g, ' ').trim()
  const header = `# ${title || 'Collection'}\n# Exported by Slinger. Variables stay as {{name}}: define them in ${HTTP_CLIENT_ENV_FILE}.\n`
  return { text: [header, ...blocks].join('\n'), usesOAuth2 }
}

export interface HttpClientEnvFiles {
  /** The environment name both files use. */
  name: string
  /** http-client.env.json: `{ "<environment>": { "name": "value" } }`, non-secret variables only. */
  env: string
  /** http-client.private.env.json: the secret variables' names with empty values, for the user to fill in. */
  privateEnv: string
  variables: number
  secrets: number
}

/**
 * The env files for the variables `scope` sees (globals < collection < active environment, as when sending), under the
 * active environment's name. Secret values never leave the keychain: secrets are listed by name with "" in the private
 * file, together with `oauth2_access_token` when the exported requests need it.
 */
export function buildHttpClientEnv(scope: TemplateScope, opts: { oauth2?: boolean } = {}): HttpClientEnvFiles {
  const name = scope.environmentName?.trim() || HTTP_CLIENT_DEFAULT_ENV
  // No prototype, so a variable named `__proto__` is just a key.
  const values: Record<string, string> = Object.create(null)
  const secrets: Record<string, string> = Object.create(null)
  for (const v of scope.variables.values()) {
    if (v.secret) secrets[v.key] = ''
    else values[v.key] = v.value ?? ''
  }
  const variables = Object.keys(values).length
  const secretCount = Object.keys(secrets).length
  if (opts.oauth2 && !(HTTP_OAUTH2_TOKEN_VARIABLE in values)) secrets[HTTP_OAUTH2_TOKEN_VARIABLE] = ''
  const json = (o: Record<string, string>) => `${JSON.stringify({ [name]: o }, null, 2)}\n`
  return { name, env: json(values), privateEnv: json(secrets), variables, secrets: secretCount }
}
