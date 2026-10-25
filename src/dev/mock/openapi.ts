/**
 * OpenAPI in the browser mock backend: the same document reading and conversion as main (shared/openapi), written
 * through the mock's Postman importer; links live in memory. URLs are not fetched (no network in the mock): a URL gives
 * the error main would give for an unreachable host.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { stableHash } from '../../../shared/openapi/fingerprint'
import { isObj, loadSpec, OpenApiError, type LoadedSpec } from '../../../shared/openapi/load'
import { openApiToPostman } from '../../../shared/openapi/toCollection'
import type { OpenApiFolderMode, OpenApiLink, OpenApiPreview, OpenApiSource, OpenApiUpdatePlan } from '../../../shared/types'
import { generate, planChanges, planStamp, writesFor, type Generated, type PlanInput } from '../../../shared/openapi/update'
import { suggestBumps } from '../../lib/semver'
import { importPostman, requestFromItem } from './postmanImport'
import { addFolder, addRequest, must, touch, type MockState } from './store'
import { clone, fail, nowSec, uuid } from './util'
import { addVersion } from './versions'

type OpenApiMockApi = Pick<
  SlingerIpcApi,
  'previewOpenApi' | 'importOpenApi' | 'getOpenApiLink' | 'unlinkOpenApi' | 'planOpenApiUpdate' | 'applyOpenApiUpdate' | 'linkOpenApi'
>

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

// ---- OpenAPI updates (begin) ----
const PLAN_TTL_MS = 10 * 60 * 1000

/** What a plan is computed from, as main's electron/openapi/update.ts reads it from SQLite. */
function planInput(s: MockState, link: MockOpenApiLink | undefined, collectionId: string, next: Generated, folders: OpenApiFolderMode): { input: PlanInput; stamp: string } {
  let previous: Generated | null = null
  if (link) {
    try {
      previous = generate(loadSpec(link.text), link.text, folders)
    } catch {
      previous = null
    }
  }
  const requests = s.requests.filter((r) => r.collectionId === collectionId)
  const variables = s.collectionVariables.filter((v) => v.ownerId === collectionId).map((v) => ({ key: v.key, value: v.value }))
  return {
    input: { next, previous, requests, folders: s.folders.filter((f) => f.collectionId === collectionId), variables, toRequest: (item) => requestFromItem(item) },
    stamp: planStamp(requests, variables.find((v) => v.key === 'baseUrl')?.value ?? null),
  }
}

function saveLink(links: Map<string, MockOpenApiLink>, collectionId: string, spec: LoadedSpec, text: string, source: OpenApiSource, folders: OpenApiFolderMode): MockOpenApiLink {
  const now = nowSec()
  const link: MockOpenApiLink = {
    collectionId, sourceKind: source.kind, source: source.value, title: spec.title, specVersion: spec.specVersion, oasVersion: spec.version, folders,
    operationCount: spec.operations.length, importedAt: links.get(collectionId)?.importedAt ?? now, updatedAt: now, text, hash: stableHash(text),
  }
  links.set(collectionId, link)
  return link
}
// ---- OpenAPI updates (end) ----

export function createOpenApiApi(state: MockState, links: Map<string, MockOpenApiLink>): OpenApiMockApi {
  const linkOut = (l: MockOpenApiLink): OpenApiLink => {
    const { text: _t, hash: _h, ...rest } = l
    return clone(rest)
  }
  const plans = new Map<string, { plan: OpenApiUpdatePlan; stamp: string; folders: OpenApiFolderMode; expiresAt: number }>()
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
    // ---- OpenAPI updates (begin) ----
    async planOpenApiUpdate(input) {
      const collection = must(state.collections, input.collectionId, 'Collection')
      const link = links.get(collection.id)
      if (input.url || (!input.text?.trim() && link?.sourceKind === 'url')) {
        fail('io_error', `Could not download the document: the mock backend has no network (${input.url ?? link?.source})`)
      }
      if (!input.text?.trim()) fail('invalid_input', link ? 'Choose the file again or paste the new version of the document' : 'Paste a document, choose a file or enter a URL')
      const spec = load(input.text)
      const folders = link?.folders ?? 'tags'
      const { input: pi, stamp } = planInput(state, link, collection.id, generate(spec, input.text, folders), folders)
      const core = planChanges(pi)
      const plan: OpenApiUpdatePlan = {
        planId: uuid(), collectionId: collection.id, title: spec.title, specVersion: spec.specVersion, previousSpecVersion: link?.specVersion ?? null,
        changes: core.ops.map((o) => o.change), notes: core.notes, warnings: core.warnings, text: input.text, source: input.source ?? { kind: 'text', value: null },
      }
      plans.set(plan.planId, { plan, stamp, folders, expiresAt: Date.now() + PLAN_TTL_MS })
      return clone(plan)
    },
    async applyOpenApiUpdate(input) {
      const stored = plans.get(input.planId)
      if (!stored || stored.expiresAt <= Date.now() || stored.plan.collectionId !== input.collectionId) fail('invalid_input', 'This update review has expired; review the update again')
      const { plan, folders } = stored
      const collection = must(state.collections, plan.collectionId, 'Collection')
      const spec = load(plan.text)
      const { input: pi, stamp } = planInput(state, links.get(collection.id), collection.id, generate(spec, plan.text, folders), folders)
      if (stamp !== stored.stamp) fail('invalid_input', 'The collection changed; review the update again')
      let writes
      try {
        writes = writesFor(pi, planChanges(pi), input.choices)
      } catch (e) {
        fail('invalid_input', (e as Error).message)
      }
      const changes = writes.add.length + writes.update.length + writes.link.length + writes.remove.length + writes.variables.length > 0 || writes.baseUrl !== null
      const versions = state.versions.filter((v) => v.collectionId === collection.id).map((v) => v.version)
      const safety = changes ? addVersion(state, collection.id, suggestBumps(versions).patch, 'Automatic snapshot before updating from the OpenAPI document') : null
      const folderIds = new Map<string, string>()
      for (const f of pi.folders) if (f.parentFolderId === null && !folderIds.has(f.name)) folderIds.set(f.name, f.id)
      for (const a of writes.add) {
        let folderId: string | null = null
        if (a.folder) {
          folderId = folderIds.get(a.folder) ?? addFolder(state, { workspaceId: collection.workspaceId, collectionId: collection.id, parentFolderId: null, name: a.folder }).id
          folderIds.set(a.folder, folderId)
        }
        addRequest(state, {
          workspaceId: collection.workspaceId, collectionId: collection.id, folderId, name: a.request.name, method: a.request.method, url: a.request.url,
          documentJson: JSON.stringify(a.request.document),
        })
      }
      for (const u of [...writes.update, ...writes.link]) {
        const r = must(state.requests, u.id, 'Request')
        Object.assign(r, { name: u.request.name, method: u.request.method, url: u.request.url, documentJson: JSON.stringify(u.request.document) })
        touch(r)
      }
      state.requests = state.requests.filter((r) => !writes.remove.includes(r.id))
      const now = nowSec()
      const setVar = (key: string, value: string, description: string | null) => {
        const row = state.collectionVariables.find((v) => v.ownerId === collection.id && v.key === key)
        if (row) return void Object.assign(touch(row), { value })
        const sortOrder = state.collectionVariables.filter((v) => v.ownerId === collection.id).length
        state.collectionVariables.push({
          id: uuid(), ownerId: collection.id, workspaceId: collection.workspaceId, key, value, isSecret: false, enabled: true, description, sortOrder,
          createdAt: now, updatedAt: now, version: 1,
        })
      }
      if (writes.baseUrl !== null) setVar('baseUrl', writes.baseUrl, 'Server URL from the API description')
      for (const v of writes.variables) setVar(v.key, v.value, v.description || null)
      const link = saveLink(links, collection.id, spec, plan.text, plan.source, folders)
      plans.delete(input.planId)
      const safetyVersion = safety ? (({ snapshot: _s, ...rest }) => rest)(safety) : null
      return clone({ added: writes.add.length, updated: writes.update.length, deleted: writes.remove.length, kept: writes.kept, safetyVersion, link: linkOut(link) })
    },
    async linkOpenApi(input) {
      const collection = must(state.collections, input.collectionId, 'Collection')
      return linkOut(saveLink(links, collection.id, load(input.text), input.text, input.source, input.folders))
    },
    // ---- OpenAPI updates (end) ----
  }
}
