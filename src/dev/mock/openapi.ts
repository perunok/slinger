/**
 * OpenAPI in the browser mock backend: the same document reading and conversion as main (shared/openapi), written
 * through the mock's Postman importer; links live in memory. URLs are not fetched (no network in the mock): a URL gives
 * the error main would give for an unreachable host.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { stableHash } from '../../../shared/openapi/fingerprint'
import { isObj, loadSpec, OpenApiError, type LoadedSpec } from '../../../shared/openapi/load'
import { openApiToPostman } from '../../../shared/openapi/toCollection'
import type { OpenApiLink, OpenApiPreview } from '../../../shared/types'
import { importPostman } from './postmanImport'
import { must, type MockState } from './store'
import { clone, fail, nowSec } from './util'

type OpenApiMockApi = Pick<SlingerIpcApi, 'previewOpenApi' | 'importOpenApi' | 'getOpenApiLink' | 'unlinkOpenApi'>

export interface MockOpenApiLink extends OpenApiLink {
  text: string
  hash: string
}

function load(text: string): LoadedSpec {
  try {
    return loadSpec(text)
  } catch (e) {
    if (e instanceof OpenApiError) fail('invalid_input', e.message)
    throw e
  }
}

function previewOf(spec: LoadedSpec, text: string): OpenApiPreview {
  const tags = new Map<string, number>()
  let untagged = 0
  for (const op of spec.operations) {
    if (op.tags[0]) tags.set(op.tags[0], (tags.get(op.tags[0]) ?? 0) + 1)
    else untagged++
  }
  const servers = Array.isArray(spec.doc.servers) ? spec.doc.servers.filter(isObj).map((s) => String(s.url ?? '')).filter(Boolean) : []
  const schemes = isObj(spec.doc.components) && isObj(spec.doc.components.securitySchemes) ? Object.keys(spec.doc.components.securitySchemes) : []
  return {
    title: spec.title, specVersion: spec.specVersion, oasVersion: spec.version, operationCount: spec.operations.length,
    tags: [...tags].map(([name, count]) => ({ name, count })), untaggedCount: untagged, servers, securitySchemes: schemes, warnings: spec.warnings, text,
  }
}

export function createOpenApiApi(state: MockState, links: Map<string, MockOpenApiLink>): OpenApiMockApi {
  const linkOut = (l: MockOpenApiLink): OpenApiLink => {
    const { text: _t, hash: _h, ...rest } = l
    return clone(rest)
  }
  return {
    async previewOpenApi(input) {
      if (input.url) fail('io_error', `Could not download the document: the mock backend has no network (${input.url})`)
      if (!input.text?.trim()) fail('invalid_input', 'Paste a document, choose a file or enter a URL')
      return previewOf(load(input.text), input.text)
    },
    async importOpenApi(input) {
      const spec = load(input.text)
      const { collection, warnings } = openApiToPostman(spec, { folders: input.folders, specText: input.text })
      const result = importPostman(state, input.workspaceId, JSON.stringify(collection), input.name !== undefined ? { name: input.name } : null)
      const now = nowSec()
      const link: MockOpenApiLink = {
        collectionId: result.collection.id, sourceKind: input.source.kind, source: input.source.value, title: spec.title, specVersion: spec.specVersion,
        oasVersion: spec.version, folders: input.folders, operationCount: spec.operations.length, importedAt: now, updatedAt: now,
        text: input.text, hash: stableHash(input.text),
      }
      links.set(link.collectionId, link)
      return { ...result, openapi: linkOut(link), warnings }
    },
    async getOpenApiLink(collectionId) {
      const l = links.get(collectionId)
      return l ? linkOut(l) : null
    },
    async unlinkOpenApi(collectionId) {
      must(state.collections, collectionId, 'Collection')
      if (!links.delete(collectionId)) fail('not_found', 'OpenAPI link not found')
    },
  }
}
