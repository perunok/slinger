<script lang="ts">
  import Button from '../../components/ui/Button.svelte'
  import { app } from '../../app/state.svelte'
  import { cloud } from './cloudStore.svelte'
</script>

<section class="space-y-3" aria-labelledby="cloud-link-h">
  <h3 id="cloud-link-h" class="text-xs font-semibold uppercase tracking-wide text-muted">Current workspace</h3>
  {#if !app.workspace}
    <p class="text-sm text-muted">No local workspace is open.</p>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-raised px-3 py-2">
      <div class="min-w-0 text-sm">
        <span class="font-medium">{app.workspace.name}</span>
        {#if cloud.link}
          <span class="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-xs text-success">Linked to {cloud.link.remoteName}</span>
        {:else}
          <span class="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning">Not linked</span>
        {/if}
      </div>
      <div class="flex gap-2">
        {#if cloud.link}
          <Button size="sm" onclick={() => cloud.unlink()}>Unlink</Button>
        {:else}
          <Button size="sm" icon="upload" loading={cloud.busy} onclick={() => cloud.publish()}>Publish to cloud</Button>
        {/if}
      </div>
    </div>
    <p class="text-xs text-muted">
      Publishing creates a remote workspace with this name and links it. Sync of collections is not available yet:
      nothing is uploaded.
    </p>
  {/if}

  <div class="flex items-center justify-between">
    <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Your cloud workspaces</h3>
    <Button size="sm" variant="ghost" icon="refresh" disabled={cloud.busy} onclick={() => cloud.refreshWorkspaces()}>Refresh</Button>
  </div>
  {#if cloud.workspaces.length === 0}
    <p class="text-sm text-muted">No cloud workspaces yet.</p>
  {:else}
    <ul class="divide-y divide-border rounded border border-border" aria-label="Cloud workspaces">
      {#each cloud.workspaces as w (w.id)}
        <li class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
          <span class="min-w-0 truncate">{w.name}{#if w.role}<span class="ml-2 text-xs text-faint">{w.role}</span>{/if}</span>
          {#if cloud.link?.remoteId === w.id}
            <span class="text-xs text-success">Linked</span>
          {:else}
            <Button size="sm" icon="link" disabled={!app.workspace || cloud.busy} onclick={() => cloud.linkTo(w)}>Link</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
