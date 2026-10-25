/**
 * Which collections have an OpenAPI document linked on this device (getOpenApiLink, cached per collection), and checking
 * a response against it (the response viewer's Spec chip, the runner's spec test). Whatever links or unlinks a document
 * (import, the OpenAPI dialog) calls `invalidateOpenApiLink` so the next read asks main again.
 */
import type { HttpResponseData, OpenApiLink, OpenApiValidation, ScriptTestResult } from '../../../shared/types'
import { api } from '../../lib/ipc'

/** Responses larger than this are not checked (main would answer "too large" anyway). */
export const MAX_SPEC_CHECK_BYTES = 5 * 1024 * 1024

class OpenApiStore {
  /** collection id -> link (null: none); a missing key means not asked yet. */
  links = $state.raw<Record<string, OpenApiLink | null>>({})
  #pending = new Map<string, Promise<OpenApiLink | null>>()
  #generation = 0

  /** The cached link, loading it when it was never asked for (reactive: the value arrives later). */
  ensure(collectionId: string): Promise<OpenApiLink | null> {
    if (collectionId in this.links) return Promise.resolve(this.links[collectionId] ?? null)
    const pending = this.#pending.get(collectionId)
    if (pending) return pending
    const generation = this.#generation
    const p = api()
      .getOpenApiLink(collectionId)
      .catch(() => null)
      .then((link) => {
        this.#pending.delete(collectionId)
        // Invalidated while loading: this answer may already be stale.
        if (generation === this.#generation) this.links = { ...this.links, [collectionId]: link }
        return link
      })
    this.#pending.set(collectionId, p)
    return p
  }

  invalidate(collectionId?: string) {
    this.#generation++
    this.#pending.clear()
    if (collectionId === undefined) this.links = {}
    else if (collectionId in this.links) {
      const { [collectionId]: _gone, ...rest } = this.links
      this.links = rest
    }
  }
}

export const openapiStore = new OpenApiStore()

/** Forget the cached link of a collection (all collections without an id): after importing, linking or unlinking. */
export function invalidateOpenApiLink(collectionId?: string): void {
  openapiStore.invalidate(collectionId)
}

export interface SpecCheckTarget {
  collectionId: string
  requestId: string | null
  method: string
  /** As written (`{{baseUrl}}/pets/:id`) or as sent. */
  url: string
}

/**
 * Checks a response against the collection's linked document. null when there is nothing to check: no link, an MCP
 * response, a body over 5 MB, or the check itself failed.
 */
export async function checkResponseAgainstSpec(target: SpecCheckTarget, response: HttpResponseData): Promise<OpenApiValidation | null> {
  if (response.mcp || response.bodyByteLength > MAX_SPEC_CHECK_BYTES) return null
  const link = await openapiStore.ensure(target.collectionId)
  if (!link) return null
  const contentType = response.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? null
  try {
    return await api().validateOpenApiResponse({
      collectionId: target.collectionId,
      requestId: target.requestId,
      method: target.method,
      url: target.url,
      status: response.status,
      contentType,
      body: response.bodyText ?? response.bodyBase64 ?? '',
      bodyEncoding: response.bodyText === null && response.bodyBase64 !== null ? 'base64' : null,
    })
  } catch {
    return null
  }
}

export const SPEC_TEST_NAME = 'Response matches the OpenAPI spec'

/** The runner's test result for a check (null when the request has no operation in the document). */
export function specTestResult(v: OpenApiValidation | null): ScriptTestResult | null {
  if (!v || v.status === 'no-spec' || v.status === 'no-operation') return null
  const source = `OpenAPI · ${v.operation ?? ''}${v.responseKey ? ` ${v.responseKey}` : ''}`.trim()
  if (v.status === 'valid' || v.status === 'no-schema') return { name: SPEC_TEST_NAME, status: 'passed', error: null, source }
  const shown = v.errors.slice(0, 5).map((e) => (e.path === '$' ? e.message : `${e.path}: ${e.message}`))
  const more = v.errors.length > 5 ? ` (and ${v.errors.length - 5} more)` : ''
  return { name: SPEC_TEST_NAME, status: 'failed', error: `${shown.join('; ')}${more}`, source }
}
