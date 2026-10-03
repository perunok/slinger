/** Browser mock of the workflow methods (electron/repositories/workflows.ts): same validation and conflicts. */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { Workflow } from '../../../shared/types'
import { must, touch, type MockState } from './store'
import { clone, cleanName, fail, nowSec, uuid } from './util'

type WorkflowsApi = Pick<SlingerIpcApi, 'listWorkflows' | 'getWorkflow' | 'createWorkflow' | 'updateWorkflow' | 'duplicateWorkflow' | 'deleteWorkflow'>

const EMPTY = '{"v":1,"nodes":[],"edges":[]}'

function assertGraph(json: unknown): string {
  if (typeof json !== 'string') fail('invalid_input', 'graphJson must be a string')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    fail('invalid_input', 'graphJson is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('invalid_input', 'graphJson must be a JSON object')
  return json
}

export function createWorkflowsApi(s: MockState): WorkflowsApi {
  const summary = ({ graphJson: _g, ...rest }: Workflow) => rest
  const create = (workspaceId: string, name: string, graphJson?: string): Workflow => {
    must(s.workspaces, workspaceId, 'Workspace')
    const now = nowSec()
    const row: Workflow = { id: uuid(), workspaceId, name: cleanName(name, 'Workflow'), graphJson: graphJson === undefined ? EMPTY : assertGraph(graphJson), createdAt: now, updatedAt: now, version: 1 }
    s.workflows.push(row)
    return clone(row)
  }
  return {
    async listWorkflows(workspaceId) {
      must(s.workspaces, workspaceId, 'Workspace')
      return s.workflows
        .filter((w) => w.workspaceId === workspaceId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt)
        .map((w) => clone(summary(w)))
    },
    async getWorkflow(id) {
      return clone(must(s.workflows, id, 'Workflow'))
    },
    async createWorkflow(input) {
      return create(input.workspaceId, input.name, input.graphJson)
    },
    async updateWorkflow(input) {
      const row = must(s.workflows, input.workflowId, 'Workflow')
      if (row.version !== input.expectedVersion) {
        fail('version_conflict', 'workflow was modified elsewhere; reload and retry', { expectedVersion: input.expectedVersion, currentVersion: row.version })
      }
      if (input.name !== undefined) row.name = cleanName(input.name, 'Workflow')
      if (input.graphJson !== undefined) row.graphJson = assertGraph(input.graphJson)
      touch(row)
      return clone(row)
    },
    async duplicateWorkflow(id, name) {
      const row = must(s.workflows, id, 'Workflow')
      return create(row.workspaceId, name ?? `${row.name} copy`, row.graphJson)
    },
    async deleteWorkflow(id) {
      must(s.workflows, id, 'Workflow')
      s.workflows = s.workflows.filter((w) => w.id !== id)
    },
  }
}
