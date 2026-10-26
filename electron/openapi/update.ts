/**
 * Updating a collection from its OpenAPI document (docs/ARCHITECTURE.md, "OpenAPI", updates): `planUpdate` compares a
 * new document with the collection's live requests (shared/openapi/update.ts), `applyUpdate` writes the user's choices
 * in one transaction after an automatic safety version, then stores the new document as the link. Plans live in memory
 * for 10 minutes; one is refused when the collection changed after it was made.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/database'
import { invalidInput } from '../lib/errors'
import { nowSeconds } from '../lib/text'
import { requireCollection } from '../repositories/common'
import { FolderRepository, RequestRepository } from '../repositories/tree'
import { CollectionVariableRepository } from '../repositories/variables'
import { createAutomaticVersion } from '../services/collectionVersions'
import { requestFromPostmanItem } from '../services/postmanImport'
import type {
  CollectionVersion, CollectionVersionAuthor, OpenApiFolderMode, OpenApiLink, OpenApiSource, OpenApiUpdateInput, OpenApiUpdatePlan, OpenApiUpdateResult,
} from '../../shared/types'
import type { LoadedSpec } from '../../shared/openapi/load'
import { generate, planChanges, planStamp, writesFor, type Generated, type ItemToRequest, type LiveFolder, type LiveRequest, type PlanInput } from '../../shared/openapi/update'
import { loadSpec, type OpenApiService } from './service'

export const PLAN_TTL_MS = 10 * 60 * 1000

interface StoredPlan {
  plan: OpenApiUpdatePlan
  stamp: string
  folders: OpenApiFolderMode
  expiresAt: number
}
const plans = new Map<string, StoredPlan>()

/** Forgets every plan (tests). */
export function clearPlans(): void {
  plans.clear()
}

const toRequest: ItemToRequest = (item, inheritedAuth) => requestFromPostmanItem(item, inheritedAuth)

interface Snapshot {
  input: PlanInput
  stamp: string
  workspaceId: string
}

/** Everything a plan is computed from, read from the database (the same reading for planning and applying). */
function snapshot(db: Db, service: OpenApiService, collectionId: string, next: Generated, folders: OpenApiFolderMode): Snapshot {
  const collection = requireCollection(db, collectionId)
  const requests = (
    db.prepare(`SELECT id, name, method, url, folder_id, document_json, version, sort_order FROM requests WHERE collection_id = ? AND deleted = 0`)
      .all(collection.id) as Array<{ id: string; name: string; method: string; url: string; folder_id: string | null; document_json: string; version: number; sort_order: number }>
  ).map((r): LiveRequest => ({ id: r.id, name: r.name, method: r.method, url: r.url, folderId: r.folder_id, documentJson: r.document_json, version: r.version, sortOrder: r.sort_order }))
  const liveFolders = (
    db.prepare('SELECT id, name, parent_folder_id, sort_order FROM folders WHERE collection_id = ? AND deleted = 0 ORDER BY sort_order, id')
      .all(collection.id) as Array<{ id: string; name: string; parent_folder_id: string | null; sort_order: number }>
  ).map((f): LiveFolder => ({ id: f.id, name: f.name, parentFolderId: f.parent_folder_id, sortOrder: f.sort_order }))
  const variables = new CollectionVariableRepository(db).list(collection.id).map((v) => ({ key: v.key, value: v.value }))
  // The linked document as it was last imported: tells user edits from what a document generated.
  let previous: Generated | null = null
  const linked = service.linkedSpec(collection.id)
  if (linked) {
    try {
      previous = generate(loadSpec(linked.text), linked.text, folders)
    } catch {
      previous = null
    }
  }
  const baseUrl = variables.find((v) => v.key === 'baseUrl')?.value ?? null
  return {
    input: { next, previous, requests, folders: liveFolders, variables, toRequest },
    stamp: planStamp(requests, baseUrl),
    workspaceId: collection.workspace_id,
  }
}

function forgetExpired(now: number): void {
  for (const [id, p] of plans) if (p.expiresAt <= now) plans.delete(id)
}

/** Compares `text` (a new version of the document) with the collection and keeps the plan for `applyUpdate`. */
export function planUpdate(db: Db, service: OpenApiService, input: { collectionId: string; text: string; source: OpenApiSource }): OpenApiUpdatePlan {
  const spec = loadSpec(input.text)
  const link = service.getLink(input.collectionId)
  const folders = link?.folders ?? 'tags'
  const snap = snapshot(db, service, input.collectionId, generate(spec, input.text, folders), folders)
  const core = planChanges(snap.input)
  const plan: OpenApiUpdatePlan = {
    planId: randomUUID(),
    collectionId: input.collectionId.toLowerCase(),
    title: spec.title,
    specVersion: spec.specVersion,
    previousSpecVersion: link?.specVersion ?? null,
    changes: core.ops.map((o) => o.change),
    notes: core.notes,
    warnings: core.warnings,
    text: input.text,
    source: input.source,
  }
  const now = Date.now()
  forgetExpired(now)
  plans.set(plan.planId, { plan, stamp: snap.stamp, folders, expiresAt: now + PLAN_TTL_MS })
  return plan
}

/**
 * `planOpenApiUpdate`: the new document from `url` (fetched), `text` (pasted or read from a file), or, with neither, the
 * linked URL again. A pasted or file document cannot be re-read here: the dialog asks for it.
 */
export async function planUpdateFrom(
  db: Db,
  service: OpenApiService,
  input: { collectionId: string; text?: string | null; url?: string | null; source?: OpenApiSource },
): Promise<OpenApiUpdatePlan> {
  requireCollection(db, input.collectionId)
  if (input.url) return planUpdate(db, service, { collectionId: input.collectionId, text: await service.fetchSpec(input.url), source: { kind: 'url', value: input.url } })
  if (typeof input.text === 'string' && input.text.trim()) {
    return planUpdate(db, service, { collectionId: input.collectionId, text: await service.textOf({ text: input.text }), source: input.source ?? { kind: 'text', value: null } })
  }
  const link = service.getLink(input.collectionId)
  if (link?.sourceKind === 'url' && link.source) {
    return planUpdate(db, service, { collectionId: input.collectionId, text: await service.fetchSpec(link.source), source: { kind: 'url', value: link.source } })
  }
  throw invalidInput(link ? 'Choose the file again or paste the new version of the document' : 'Paste a document, choose a file or enter a URL')
}

/** Applies a plan with the user's choices (keys left out: the plan's default), in one transaction. */
export function applyUpdate(db: Db, service: OpenApiService, input: OpenApiUpdateInput, author: CollectionVersionAuthor | null = null): OpenApiUpdateResult {
  const stored = plans.get(input.planId)
  if (!stored || stored.expiresAt <= Date.now() || stored.plan.collectionId !== input.collectionId.toLowerCase()) {
    if (stored && stored.expiresAt <= Date.now()) plans.delete(input.planId)
    throw invalidInput('This update review has expired; review the update again')
  }
  const { plan, folders } = stored
  const spec: LoadedSpec = loadSpec(plan.text)
  const result = db.transaction((): OpenApiUpdateResult => {
    const snap = snapshot(db, service, plan.collectionId, generate(spec, plan.text, folders), folders)
    if (snap.stamp !== stored.stamp) throw invalidInput('The collection changed; review the update again')
    // Same inputs as when planning, so the same plan (deterministic).
    const core = planChanges(snap.input)
    let writes
    try {
      writes = writesFor(snap.input, core, input.choices)
    } catch (e) {
      throw invalidInput((e as Error).message)
    }
    const changesSomething = writes.add.length + writes.update.length + writes.link.length + writes.remove.length + writes.variables.length > 0 || writes.baseUrl !== null
    let safetyVersion: CollectionVersion | null = null
    if (changesSomething) {
      safetyVersion = createAutomaticVersion(db, plan.collectionId, 'updating from the OpenAPI document', author)
    }
    const folderRepo = new FolderRepository(db)
    const requestRepo = new RequestRepository(db)
    const vars = new CollectionVariableRepository(db)

    // Added requests go into the top-level folder named after their tag (created at the end when missing).
    const folderIds = new Map<string, string>()
    for (const f of snap.input.folders) if (f.parentFolderId === null && !folderIds.has(f.name)) folderIds.set(f.name, f.id)
    for (const a of writes.add) {
      let folderId: string | null = null
      if (a.folder) {
        folderId = folderIds.get(a.folder) ?? null
        if (!folderId) {
          folderId = folderRepo.create({ workspaceId: snap.workspaceId, collectionId: plan.collectionId, parentFolderId: null, name: a.folder }).id
          folderIds.set(a.folder, folderId)
        }
      }
      requestRepo.create({
        workspaceId: snap.workspaceId, collectionId: plan.collectionId, folderId, name: a.request.name.slice(0, 500), method: a.request.method,
        url: a.request.url, documentJson: JSON.stringify(a.request.document),
      })
    }
    // Updates keep id, folder and sort order; the version bump lets sync pick them up.
    const now = nowSeconds()
    const update = db.prepare('UPDATE requests SET name = ?, method = ?, url = ?, document_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
    for (const u of [...writes.update, ...writes.link]) {
      update.run(u.request.name.slice(0, 500), u.request.method.slice(0, 32), u.request.url, JSON.stringify(u.request.document), now, u.id)
    }
    for (const id of writes.remove) requestRepo.softDelete(id)
    if (writes.baseUrl !== null) {
      vars.upsert({ collectionId: plan.collectionId, key: 'baseUrl', value: writes.baseUrl, ...(snap.input.variables.some((v) => v.key === 'baseUrl') ? {} : { description: 'Server URL from the API description' }) })
    }
    for (const v of writes.variables) vars.upsert({ collectionId: plan.collectionId, key: v.key, value: v.value, description: v.description || null })

    const link: OpenApiLink = service.saveLink(plan.collectionId, snap.workspaceId, spec, plan.text, plan.source, folders)
    return { added: writes.add.length, updated: writes.update.length, deleted: writes.remove.length, kept: writes.kept, safetyVersion, link }
  })()
  plans.delete(input.planId)
  return result
}

/** Links a collection to a document without changing its requests (they are matched when the update is planned). */
export function linkSpec(db: Db, service: OpenApiService, input: { collectionId: string; text: string; source: OpenApiSource; folders: OpenApiFolderMode }): OpenApiLink {
  const collection = requireCollection(db, input.collectionId)
  const spec = loadSpec(input.text)
  return service.saveLink(collection.id, collection.workspace_id, spec, input.text, input.source, input.folders)
}
