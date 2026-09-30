<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { runsStore } from '../runner/runs.svelte'

  /** A workspace to switch to once the user confirmed that its collection runs stop. */
  let pending = $state<string | null>(null)
  const warning = $derived(pending ? runsStore.switchWarning() : null)

  function change(id: string, select: HTMLSelectElement) {
    if (id === app.workspaceId) return
    if (runsStore.switchWarning()) {
      // Keep showing the current workspace until the switch is confirmed.
      select.value = app.workspaceId ?? ''
      pending = id
      return
    }
    void open(id)
  }

  async function open(id: string) {
    try {
      await app.selectWorkspace(id)
    } catch (e) {
      toast.error('Could not open workspace', errorInfo(e).message)
    }
  }
</script>

<div class="flex items-center gap-1">
  <label for="ws-select" class="sr-only">Workspace</label>
  <select id="ws-select" class="h-7 max-w-48 py-0" value={app.workspaceId ?? ''} onchange={(e) => change(e.currentTarget.value, e.currentTarget)}>
    {#each app.workspaces as w (w.id)}<option value={w.id}>{w.name}{w.workspaceType === 'team' ? ' (team)' : ''}</option>{/each}
  </select>
  <IconButton icon="settings" label="Manage workspaces" onclick={() => (ui.workspacesOpen = true)} />
</div>

{#if pending}
  <ConfirmDialog
    title="Switch workspace?"
    message={warning ?? 'Switch to the other workspace?'}
    confirmLabel="Stop run and switch"
    danger
    onconfirm={() => {
      const id = pending!
      pending = null
      return open(id)
    }}
    oncancel={() => (pending = null)}
  />
{/if}
