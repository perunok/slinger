<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import { errorInfo } from '../../lib/ipc'

  async function change(id: string) {
    try {
      await app.selectWorkspace(id)
    } catch (e) {
      toast.error('Could not open workspace', errorInfo(e).message)
    }
  }
</script>

<div class="flex items-center gap-1">
  <label for="ws-select" class="sr-only">Workspace</label>
  <select id="ws-select" class="h-7 max-w-48 !py-0" value={app.workspaceId ?? ''} onchange={(e) => change(e.currentTarget.value)}>
    {#each app.workspaces as w (w.id)}<option value={w.id}>{w.name}{w.workspaceType === 'team' ? ' (team)' : ''}</option>{/each}
  </select>
  <IconButton icon="settings" label="Manage workspaces" onclick={() => (ui.workspacesOpen = true)} />
</div>
