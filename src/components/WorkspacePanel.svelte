<script lang="ts">
  import type { Workspace } from '../tauri'

  export let workspaces: Workspace[]
</script>

<div class="mt-4 space-y-3">
  {#each workspaces as workspace (workspace.id)}
    <div class="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3">
      <p class="text-sm font-medium text-slate-100">{workspace.name}</p>
      <p class="text-xs text-slate-500">Workspace ID: {workspace.id}</p>
    </div>
  {/each}
</div>
