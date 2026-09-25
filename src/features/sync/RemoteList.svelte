<script lang="ts">
  /** Cloud workspaces of the signed-in account, each with a Link action. */
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { sync } from './syncStore.svelte'

  const localName = (id: string | null) => (id ? (app.workspaces.find((w) => w.id === id)?.name ?? 'another workspace') : null)
</script>

<section class="space-y-2" aria-labelledby="cloud-remotes-h">
  <div class="flex items-center justify-between">
    <h3 id="cloud-remotes-h" class="text-xs font-semibold uppercase tracking-wide text-muted">Your cloud workspaces</h3>
    <Button size="sm" variant="ghost" icon="refresh" disabled={sync.remotesLoading} onclick={() => sync.loadRemotes()}>Refresh</Button>
  </div>
  {#if sync.remotesError}
    <p role="alert" class="rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs text-danger">{sync.remotesError}</p>
  {:else if sync.remotes.length === 0}
    <p class="text-sm text-muted">{sync.remotesLoading ? 'Loading…' : 'No cloud workspaces yet. Publish a workspace to create one.'}</p>
  {:else}
    <ul class="divide-y divide-border rounded border border-border" aria-label="Cloud workspaces">
      {#each sync.remotes as w (w.id)}
        <li class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
          <span class="min-w-0 truncate">{w.name}<span class="ml-2 text-xs text-faint">{w.role}{w.role === 'viewer' ? ' (read-only)' : ''}</span></span>
          {#if w.linkedLocalWorkspaceId}
            <span class="shrink-0 text-xs text-success">Linked to {localName(w.linkedLocalWorkspaceId)}</span>
          {:else}
            <Button size="sm" icon="link" onclick={() => (ui.linkOpen = { remoteId: w.id })}>Link…</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
