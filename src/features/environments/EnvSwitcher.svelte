<script lang="ts">
  import IconButton from '../../components/ui/IconButton.svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import { errorInfo } from '../../lib/ipc'

  async function change(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value
    try {
      await app.setActiveEnvironment(value === '' ? null : value)
    } catch (err) {
      toast.error('Could not switch environment', errorInfo(err).message)
    }
  }
</script>

<div class="flex items-center gap-1">
  <select
    aria-label="Active environment"
    class="h-7 max-w-[12rem] rounded border border-border bg-raised px-1.5 text-xs text-fg outline-none focus:border-accent"
    value={app.activeEnvironmentId ?? ''}
    onchange={change}
  >
    <option value="">No environment</option>
    {#each app.environments as env (env.id)}
      <option value={env.id}>{env.name}</option>
    {/each}
  </select>
  <IconButton icon="settings" label="Manage environments" onclick={() => (ui.envEditor = { open: true })} />
</div>
