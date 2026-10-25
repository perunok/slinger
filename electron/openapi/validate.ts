/**
 * Response validation in main: the shared engine (shared/openapi/validate.ts) with ajv 8, and the service behind the
 * `validateOpenApiResponse` IPC method (reads the collection's link, keeps parsed documents per hash, finds the request's
 * stored operation key). See docs/ARCHITECTURE.md, "OpenAPI".
 */
import type { Db } from '../db/database'
import type { OpenApiValidation, OpenApiValidationInput } from '../../shared/types'
import { isObj, loadSpec, type LoadedSpec } from '../../shared/openapi/load'
import { createResponseValidator, type ResponseValidator } from '../../shared/openapi/validate'

let engine: ResponseValidator | null = null

/**
 * The engine, created on the first check: ajv is bundled into app.cjs, but esbuild initialises a bundled CommonJS module
 * only when it is first required, so a launch that never validates never runs ajv's (large) module code.
 */
export function responseValidator(): ResponseValidator {
  if (!engine) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const draft7 = require('ajv8') as typeof import('ajv8')
    const draft2020 = require('ajv8/dist/2020') as typeof import('ajv8/dist/2020')
    /* eslint-enable @typescript-eslint/no-require-imports */
    engine = createResponseValidator({ draft7: draft7.default, draft2020: draft2020.default })
  }
  return engine
}

/** Checks a response against a loaded document (see shared/openapi/validate.ts). */
export function validateResponse(spec: LoadedSpec, specHash: string, input: OpenApiValidationInput, requestOperationKey: string | null): OpenApiValidation {
  return responseValidator().validate(spec, specHash, input, requestOperationKey)
}

const NO_SPEC: OpenApiValidation = { status: 'no-spec', operation: null, responseKey: null, errors: [] }
/** Parsed documents kept (by hash): a run checks many responses against the same one. */
const SPEC_CACHE = 4

export interface OpenApiValidationDeps {
  db: Db
  /** The linked document text and hash (OpenApiService.linkedSpec). */
  linkedSpec(collectionId: string): { text: string; hash: string } | null
}

export class OpenApiValidationService {
  readonly #deps: OpenApiValidationDeps
  readonly #specs = new Map<string, LoadedSpec>()

  constructor(deps: OpenApiValidationDeps) {
    this.#deps = deps
  }

  validate(input: OpenApiValidationInput): OpenApiValidation {
    // The hash first: the document text (possibly MBs) is read only when it is not parsed yet.
    const row = this.#deps.db.prepare('SELECT spec_hash FROM collection_openapi WHERE collection_id = ?').get(input.collectionId) as { spec_hash: string } | undefined
    if (!row) return NO_SPEC
    const spec = this.#spec(input.collectionId, row.spec_hash)
    if (!spec) return NO_SPEC
    return validateResponse(spec.spec, spec.hash, input, input.requestId ? this.#operationKey(input.requestId) : null)
  }

  #spec(collectionId: string, hash: string): { spec: LoadedSpec; hash: string } | null {
    const hit = this.#specs.get(hash)
    if (hit) {
      this.#specs.delete(hash)
      this.#specs.set(hash, hit)
      return { spec: hit, hash }
    }
    const linked = this.#deps.linkedSpec(collectionId)
    if (!linked) return null
    let spec: LoadedSpec
    try {
      spec = loadSpec(linked.text)
    } catch {
      // The stored document was readable when it was imported; if it no longer is, there is nothing to check against.
      return null
    }
    this.#specs.set(linked.hash, spec)
    if (this.#specs.size > SPEC_CACHE) this.#specs.delete(this.#specs.keys().next().value!)
    return { spec, hash: linked.hash }
  }

  /** The operation key stored in the request's document (`openapi.key`), if any. */
  #operationKey(requestId: string): string | null {
    const row = this.#deps.db.prepare('SELECT document_json FROM requests WHERE id = ? AND deleted = 0').get(requestId) as { document_json: string } | undefined
    if (!row) return null
    try {
      const doc = JSON.parse(row.document_json) as unknown
      return isObj(doc) && isObj(doc.openapi) && typeof doc.openapi.key === 'string' ? doc.openapi.key : null
    } catch {
      return null
    }
  }
}
