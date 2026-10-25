/**
 * OpenAPI in the main process: preview and import a document (pasted, from a file, or fetched by URL here, never by the
 * renderer), and the collection's local link to it (table collection_openapi). Validation (validate.ts) and updates
 * (update.ts) read the link. See docs/ARCHITECTURE.md, "OpenAPI".
 */
import type { Db } from '../db/database'
import { invalidInput, ioError, notFound } from '../lib/errors'
import { requireCollection, requireWorkspace } from '../repositories/common'
import { importPostmanCollection, MAX_IMPORT_BYTES } from '../services/postmanImport'
import type { OpenApiFolderMode, OpenApiImportInput, OpenApiImportResult, OpenApiLink, OpenApiPreview, OpenApiSource } from '../../shared/types'
import { stableHash } from '../../shared/openapi/fingerprint'
import { isObj, loadSpec as loadSpecRaw, OpenApiError, type LoadedSpec } from '../../shared/openapi/load'
import { openApiToPostman } from '../../shared/openapi/toCollection'
import { OpenApiValidationService } from './validate'

/** loadSpec with document problems as `invalid_input`. */
export function loadSpec(text: string): LoadedSpec {
  try {
    return loadSpecRaw(text)
  } catch (e) {
    if (e instanceof OpenApiError) throw invalidInput(e.message)
    throw e
  }
}

const FETCH_TIMEOUT_MS = 30_000

interface LinkRow {
  collection_id: string
  workspace_id: string
  source_kind: OpenApiSource['kind']
  source: string | null
  spec_text: string
  spec_hash: string
  title: string
  spec_version: string
  oas_version: '2.0' | '3.0' | '3.1'
  folders: OpenApiFolderMode
  operation_count: number
  imported_at: number
  updated_at: number
}

export interface OpenApiServiceDeps {
  db: Db
  /** Electron's net.fetch in the app (system proxy); global fetch in tests. */
  fetchImpl?: typeof fetch
  /** Unix seconds. */
  now?: () => number
}

const toLink = (r: LinkRow): OpenApiLink => ({
  collectionId: r.collection_id,
  sourceKind: r.source_kind,
  source: r.source,
  title: r.title,
  specVersion: r.spec_version,
  oasVersion: r.oas_version,
  folders: r.folders,
  operationCount: r.operation_count,
  importedAt: r.imported_at,
  updatedAt: r.updated_at,
})

export function previewOf(spec: LoadedSpec, text: string): OpenApiPreview {
  const tags = new Map<string, number>()
  let untagged = 0
  for (const op of spec.operations) {
    if (op.tags[0]) tags.set(op.tags[0], (tags.get(op.tags[0]) ?? 0) + 1)
    else untagged++
  }
  const servers = Array.isArray(spec.doc.servers) ? spec.doc.servers.filter(isObj).map((s) => String(s.url ?? '')).filter(Boolean) : []
  const schemes = isObj(spec.doc.components) && isObj(spec.doc.components.securitySchemes) ? Object.keys(spec.doc.components.securitySchemes) : []
  return {
    title: spec.title,
    specVersion: spec.specVersion,
    oasVersion: spec.version,
    operationCount: spec.operations.length,
    tags: [...tags].map(([name, count]) => ({ name, count })),
    untaggedCount: untagged,
    servers,
    securitySchemes: schemes,
    warnings: spec.warnings,
    text,
  }
}

export class OpenApiService {
  private readonly db: Db
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  /** Checks responses against the linked document (validate.ts). */
  readonly validation: OpenApiValidationService

  constructor(deps: OpenApiServiceDeps) {
    this.db = deps.db
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    this.validation = new OpenApiValidationService({ db: deps.db, linkedSpec: (id) => this.linkedSpec(id) })
  }

  /** Downloads a document (http/https only, 50 MB, 30 s). */
  async fetchSpec(url: string): Promise<string> {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      throw invalidInput('Not a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidInput('Only http and https URLs can be imported')
    let res: Response
    try {
      res = await this.fetchImpl(parsed.toString(), {
        redirect: 'follow',
        credentials: 'omit',
        headers: { Accept: 'application/json, application/yaml, application/x-yaml, text/yaml, */*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (e) {
      const timeout = (e as Error)?.name === 'TimeoutError'
      throw ioError(timeout ? `${parsed.host} did not answer within ${FETCH_TIMEOUT_MS / 1000} s` : `Could not download the document: ${(e as Error)?.message ?? String(e)}`)
    }
    if (!res.ok) throw ioError(`Could not download the document: ${res.status} ${res.statusText}`.trim(), { status: res.status })
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_IMPORT_BYTES) throw invalidInput('The document is larger than 50 MB')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_IMPORT_BYTES) throw invalidInput('The document is larger than 50 MB')
    return buf.toString('utf8')
  }

  async textOf(input: { text?: string | null; url?: string | null }): Promise<string> {
    if (input.url) return this.fetchSpec(input.url)
    if (typeof input.text === 'string' && input.text.trim()) {
      if (input.text.length > MAX_IMPORT_BYTES) throw invalidInput('The document is larger than 50 MB')
      return input.text
    }
    throw invalidInput('Paste a document, choose a file or enter a URL')
  }

  async preview(input: { text?: string | null; url?: string | null }): Promise<OpenApiPreview> {
    const text = await this.textOf(input)
    return previewOf(loadSpec(text), text)
  }

  /** Imports the document as a new collection and links the collection to it, in one transaction. */
  import(input: OpenApiImportInput): OpenApiImportResult {
    requireWorkspace(this.db, input.workspaceId)
    const spec = loadSpec(input.text)
    const { collection, warnings } = openApiToPostman(spec, { folders: input.folders, specText: input.text })
    return this.db.transaction((): OpenApiImportResult => {
      const result = importPostmanCollection(this.db, input.workspaceId, JSON.stringify(collection), input.name !== undefined ? { name: input.name } : {})
      const link = this.saveLink(result.collection.id, input.workspaceId, spec, input.text, input.source, input.folders)
      return { ...result, openapi: link, warnings }
    })()
  }

  /** Stores (or replaces) the collection's link to a document. */
  saveLink(collectionId: string, workspaceId: string, spec: LoadedSpec, text: string, source: OpenApiSource, folders: OpenApiFolderMode): OpenApiLink {
    const now = this.now()
    const existing = this.row(collectionId)
    this.db
      .prepare(
        `INSERT INTO collection_openapi (collection_id, workspace_id, source_kind, source, spec_text, spec_hash, title, spec_version, oas_version,
           folders, operation_count, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection_id) DO UPDATE SET source_kind = excluded.source_kind, source = excluded.source, spec_text = excluded.spec_text,
           spec_hash = excluded.spec_hash, title = excluded.title, spec_version = excluded.spec_version, oas_version = excluded.oas_version,
           folders = excluded.folders, operation_count = excluded.operation_count, updated_at = excluded.updated_at`,
      )
      .run(collectionId, workspaceId, source.kind, source.value, text, stableHash(text), spec.title, spec.specVersion, spec.version, folders,
        spec.operations.length, existing?.imported_at ?? now, now)
    return toLink(this.row(collectionId)!)
  }

  row(collectionId: string): LinkRow | undefined {
    return this.db.prepare('SELECT * FROM collection_openapi WHERE collection_id = ?').get(collectionId) as LinkRow | undefined
  }

  getLink(collectionId: string): OpenApiLink | null {
    const r = this.row(collectionId)
    return r ? toLink(r) : null
  }

  /** The linked document text and its hash (validation, updates); null without a link. */
  linkedSpec(collectionId: string): { text: string; hash: string; folders: OpenApiFolderMode; source: OpenApiSource } | null {
    const r = this.row(collectionId)
    return r ? { text: r.spec_text, hash: r.spec_hash, folders: r.folders, source: { kind: r.source_kind, value: r.source } } : null
  }

  unlink(collectionId: string): void {
    requireCollection(this.db, collectionId)
    const n = this.db.prepare('DELETE FROM collection_openapi WHERE collection_id = ?').run(collectionId).changes
    if (n === 0) throw notFound('OpenAPI link')
  }
}
