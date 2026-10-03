import type { CreateWorkflowInput, UpdateWorkflowInput, Workflow, WorkflowSummary } from '../../shared/types'
import { invalidInput, notFound, versionConflict } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'
import { cleanName, nowSeconds } from '../lib/text'
import { requireWorkspace, type Db } from './common'

interface WorkflowRow {
  id: string
  workspace_id: string
  name: string
  graph_json: string
  version: number
  created_at: number
  updated_at: number
}

/** A graph document is a JSON object; 5 MB is far above any hand-built canvas (positions, configs, small scripts). */
export const MAX_GRAPH_JSON = 5 * 1024 * 1024
export const EMPTY_GRAPH_JSON = '{"v":1,"nodes":[],"edges":[]}'

const SUMMARY_COLUMNS = 'id, workspace_id, name, version, created_at, updated_at'

const toSummary = (r: Omit<WorkflowRow, 'graph_json'>): WorkflowSummary => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})

export function assertGraphJson(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('graphJson must be a string')
  if (value.length > MAX_GRAPH_JSON) throw invalidInput('graphJson is too large (5 MB at most)')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalidInput('graphJson is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalidInput('graphJson must be a JSON object')
  return value
}

/**
 * Workflows (migration 0010). Local-only: no sync capture, no read-only triggers. Soft delete; reads require a live
 * workspace. Names need not be unique (like requests).
 */
export class WorkflowRepository {
  constructor(private readonly db: Db) {}

  list(workspaceId: string): WorkflowSummary[] {
    const ws = requireWorkspace(this.db, workspaceId)
    return (
      this.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM workflows WHERE workspace_id = ? AND deleted = 0 ORDER BY name COLLATE NOCASE, created_at, id`)
        .all(ws.id) as WorkflowRow[]
    ).map(toSummary)
  }

  get(id: string): Workflow {
    const row = this.db
      .prepare(
        `SELECT f.* FROM workflows f JOIN workspaces w ON w.id = f.workspace_id
         WHERE f.id = ? AND f.deleted = 0 AND w.deleted = 0`,
      )
      .get(assertUuid(id, 'workflowId')) as WorkflowRow | undefined
    if (!row) throw notFound('workflow')
    return { ...toSummary(row), graphJson: row.graph_json }
  }

  create(input: CreateWorkflowInput): Workflow {
    const ws = requireWorkspace(this.db, input.workspaceId)
    const name = cleanName(input.name, 'workflow name', 200)
    const graphJson = input.graphJson === undefined ? EMPTY_GRAPH_JSON : assertGraphJson(input.graphJson)
    const id = newId()
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT INTO workflows (id, workspace_id, name, graph_json, version, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, ws.id, name, graphJson, now, now)
    return this.get(id)
  }

  update(input: UpdateWorkflowInput): Workflow {
    const current = this.get(input.workflowId)
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw invalidInput('expectedVersion must be a positive integer')
    }
    const name = input.name === undefined ? current.name : cleanName(input.name, 'workflow name', 200)
    const graphJson = input.graphJson === undefined ? current.graphJson : assertGraphJson(input.graphJson)
    const result = this.db
      .prepare(
        `UPDATE workflows SET name = ?, graph_json = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ? AND deleted = 0`,
      )
      .run(name, graphJson, nowSeconds(), current.id, input.expectedVersion)
    if (result.changes === 0) {
      throw versionConflict('workflow was modified elsewhere; reload and retry', {
        expectedVersion: input.expectedVersion,
        currentVersion: current.version,
      })
    }
    return this.get(current.id)
  }

  /** A copy in the same workspace, named "<name> copy" unless a name is given. */
  duplicate(id: string, name?: string): Workflow {
    const source = this.get(id)
    return this.create({ workspaceId: source.workspaceId, name: name ?? `${source.name} copy`, graphJson: source.graphJson })
  }

  delete(id: string): void {
    const current = this.get(id)
    this.db
      .prepare('UPDATE workflows SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ? AND deleted = 0')
      .run(nowSeconds(), current.id)
  }

  /** Part of a workspace delete (same transaction). */
  static cascadeWorkspace(db: Db, workspaceId: string, now: number): void {
    db.prepare('UPDATE workflows SET deleted = 1, updated_at = ?, version = version + 1 WHERE workspace_id = ? AND deleted = 0').run(now, workspaceId)
  }
}
