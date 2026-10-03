/** Create / rename / duplicate / delete workflows (sidebar, tab menu). Failures are toasts; nothing throws. */
import type { Workflow } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { serializeGraph, starterGraph } from '../../lib/workflow/graph'
import { uuid } from '../../lib/template'
import { tabsStore } from '../requests/tabs.svelte'
import { workflowRuns } from './workflowRuns.svelte'

export async function createWorkflow(name: string): Promise<Workflow | null> {
  const workspaceId = app.workspaceId
  if (!workspaceId) return null
  try {
    const created = await api().createWorkflow({ workspaceId, name, graphJson: serializeGraph(starterGraph(uuid)) })
    app.upsertWorkflow(created)
    tabsStore.openWorkflow(created.id)
    return created
  } catch (e) {
    toast.error('Could not create the workflow', errorInfo(e).message)
    return null
  }
}

/** Renames with the latest version (a rename never conflicts with the editor's own saves). Throws for NameDialog. */
export async function renameWorkflow(id: string, name: string): Promise<void> {
  const current = await api().getWorkflow(id)
  const updated = await api().updateWorkflow({ workflowId: id, expectedVersion: current.version, name })
  app.upsertWorkflow(updated)
  workflowEvents.dispatchEvent(new CustomEvent('changed', { detail: updated }))
}

export async function duplicateWorkflow(id: string): Promise<void> {
  try {
    const copy = await api().duplicateWorkflow(id)
    app.upsertWorkflow(copy)
    tabsStore.openWorkflow(copy.id)
  } catch (e) {
    toast.error('Could not duplicate the workflow', errorInfo(e).message)
  }
}

/** Throws for ConfirmDialog (shown inline). Stops its run and closes its tab. */
export async function deleteWorkflow(id: string): Promise<void> {
  workflowRuns.stop(id)
  await api().deleteWorkflow(id)
  app.removeWorkflowLocal(id)
  workflowRuns.clear(id)
  tabsStore.syncWorkflowTabs()
}

/** `changed` (detail: Workflow) after a rename elsewhere, so an open editor adopts the new version. */
export const workflowEvents = new EventTarget()
