<script lang="ts">
  import type { Workspace } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import NameDialog from '../../components/ui/NameDialog.svelte'
  import { api } from '../../lib/ipc'

  type Sub = { t: 'create' } | { t: 'rename'; ws: Workspace } | { t: 'delete'; ws: Workspace }
  let sub = $state<Sub | null>(null)

  async function create(name: string) {
    const ws = await api().createWorkspace(name)
    await app.refreshWorkspaces()
    await app.selectWorkspace(ws.id)
    toast.success(`Workspace “${ws.name}” created`)
  }
  async function rename(ws: Workspace, name: string) {
    await api().renameWorkspace(ws.id, name)
    await app.refreshWorkspaces()
  }
  async function remove(ws: Workspace) {
    await api().deleteWorkspace(ws.id)
    const rest = app.workspaces.filter((w) => w.id !== ws.id)
    if (rest.length === 0) {
      await app.loadWorkspaces()
    } else {
      await app.refreshWorkspaces()
      if (app.workspaceId === ws.id) await app.selectWorkspace(app.workspaces[0].id)
    }
  }
</script>

<Dialog title="Workspaces" onclose={() => (ui.workspacesOpen = false)} size="md">
  <ul class="divide-y divide-border rounded border border-border" aria-label="Workspaces">
    {#each app.workspaces as w (w.id)}
      <li class="flex items-center gap-2 px-3 py-2">
        <span class="min-w-0 flex-1 truncate">{w.name}</span>
        {#if w.workspaceType === 'team'}<span class="rounded bg-raised px-1.5 text-xs text-muted">team</span>{/if}
        {#if w.id === app.workspaceId}<span class="rounded bg-accent-soft px-1.5 text-xs">current</span>{/if}
        {#if w.id !== app.workspaceId}<Button size="sm" onclick={() => app.selectWorkspace(w.id)}>Open</Button>{/if}
        <IconButton icon="edit" label="Rename {w.name}" onclick={() => (sub = { t: 'rename', ws: w })} />
        <IconButton icon="trash" label="Delete {w.name}" onclick={() => (sub = { t: 'delete', ws: w })} />
      </li>
    {/each}
  </ul>
  {#snippet footer()}
    <Button icon="plus" onclick={() => (sub = { t: 'create' })}>New workspace</Button>
    <Button variant="primary" onclick={() => (ui.workspacesOpen = false)}>Done</Button>
  {/snippet}
</Dialog>

{#if sub}
  {#if sub.t === 'create'}
    <NameDialog title="New workspace" label="Workspace name" submitLabel="Create" onsubmit={create} oncancel={() => (sub = null)} />
  {:else if sub.t === 'rename'}
    {@const ws = sub.ws}
    <NameDialog title="Rename workspace" label="Name" initial={ws.name} submitLabel="Rename" onsubmit={(n) => rename(ws, n)} oncancel={() => (sub = null)} />
  {:else}
    {@const ws = sub.ws}
    <ConfirmDialog
      title="Delete workspace"
      message="Delete “{ws.name}” with all its collections, requests, environments and history? This cannot be undone."
      confirmLabel="Delete workspace"
      danger
      onconfirm={() => remove(ws)}
      oncancel={() => (sub = null)}
    />
  {/if}
{/if}
