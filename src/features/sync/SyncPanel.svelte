<script lang="ts">
  /** "Current workspace" section of the Cloud dialog: publish / link / unlink, sync now, auto sync, conflicts. */
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import { formatAgo } from './status'
  import { sync } from './syncStore.svelte'

  const ws = $derived(app.workspace)
  const status = $derived(sync.current)
  const chip = $derived(sync.chip)
  const linked = $derived(!!status?.linked)
  const syncing = $derived(status?.state === 'syncing' || sync.busy[ws?.id ?? ''] === 'sync')
  const hint = $derived(ws ? sync.legacyLinks.find((h) => h.localWorkspaceId === ws.id) : undefined)
  let confirmUnlink = $state(false)
  let confirmDiscard = $state(false)
</script>

<section class="space-y-3" aria-labelledby="cloud-link-h">
  <h3 id="cloud-link-h" class="text-xs font-semibold uppercase tracking-wide text-muted">Current workspace</h3>
  {#if !ws}
    <p class="text-sm text-muted">No local workspace is open.</p>
  {:else}
    <div class="space-y-2 rounded border border-border bg-raised px-3 py-2" data-testid="sync-panel">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 text-sm">
          <span class="font-medium">{ws.name}</span>
          {#if linked}
            <span class="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-xs text-success">Synced with {status?.remoteName}</span>
            {#if status?.role}<span class="ml-1 text-xs text-faint">{status.role}</span>{/if}
          {:else}
            <span class="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning">Local only</span>
          {/if}
        </div>
        <div class="flex flex-wrap gap-2">
          {#if linked}
            <Button size="sm" icon="refresh" loading={syncing} onclick={() => sync.syncNow(ws.id)} disabled={status?.state === 'signedOut' || status?.state === 'serverUnsupported' || status?.state === 'accessRevoked'}>Sync now</Button>
            <Button size="sm" onclick={() => (confirmUnlink = true)}>Unlink</Button>
          {:else}
            <Button size="sm" variant="primary" icon="upload" disabled={!sync.signedIn || sync.serverUnsupported} onclick={() => (ui.publishOpen = true)}>Publish to cloud…</Button>
            <Button size="sm" icon="link" disabled={!sync.signedIn || sync.serverUnsupported} onclick={() => (ui.linkOpen = { remoteId: null })}>Link a cloud workspace…</Button>
          {/if}
        </div>
      </div>

      {#if linked && status}
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt class="text-muted">Status</dt>
          <dd data-testid="sync-state">{chip.label}<span class="text-muted"> - {chip.detail}</span></dd>
          <dt class="text-muted">Last synced</dt>
          <dd>{formatAgo(status.lastSyncedAt, sync.now)}</dd>
          <dt class="text-muted">Waiting to upload</dt>
          <dd>{status.pendingChanges} change{status.pendingChanges === 1 ? '' : 's'}</dd>
          {#if status.lastError}
            <dt class="text-muted">Last error</dt>
            <dd class="text-danger">{status.lastError.message}</dd>
          {/if}
        </dl>
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={status.autoSync} onchange={(e) => sync.setAutoSync(ws.id, e.currentTarget.checked)} disabled={status.state === 'accessRevoked'} />
            Auto sync
          </label>
          <span class="text-xs text-muted">Checks for cloud changes regularly and uploads yours shortly after you save.</span>
        </div>
        {#if status.openConflicts > 0}
          <div class="flex items-center justify-between gap-2 rounded border border-warning bg-warning-soft px-2 py-1.5 text-sm">
            <span>{status.openConflicts} conflict{status.openConflicts === 1 ? '' : 's'} need{status.openConflicts === 1 ? 's' : ''} your decision.</span>
            <Button size="sm" variant="primary" onclick={() => (ui.conflictsOpen = true)}>Review conflicts</Button>
          </div>
        {/if}
        {#if status.readOnly && status.pendingChanges > 0}
          <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-warning bg-warning-soft px-2 py-1.5 text-sm">
            <span>Your role is read-only: {status.pendingChanges} local change{status.pendingChanges === 1 ? '' : 's'} cannot be uploaded.</span>
            <Button size="sm" variant="danger" onclick={() => (confirmDiscard = true)}>Discard local changes</Button>
          </div>
        {/if}
      {:else}
        {#if hint}
          <p class="flex items-start justify-between gap-2 rounded border border-border bg-surface px-2 py-1.5 text-xs" data-testid="legacy-hint">
            <span>This workspace used to be linked to <strong>{hint.remoteName}</strong>. Older versions never uploaded content, so link it again to start syncing.</span>
            <button type="button" class="shrink-0 underline" onclick={() => sync.dismissLegacy(ws.id)}>Dismiss</button>
          </p>
        {/if}
        <p class="text-xs text-muted">
          {#if sync.signedIn}
            Publishing uploads this workspace's collections, folders, requests, environments and versions to a new cloud workspace and keeps them in sync.
            Secret variable values never leave this device.
          {:else}
            Sign in above to publish this workspace or link a cloud workspace.
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</section>

{#if confirmUnlink && ws}
  <ConfirmDialog
    title="Unlink workspace"
    message={`Stop syncing "${ws.name}" with the cloud? Everything stays on this device and in the cloud.${status && status.pendingChanges > 0 ? `\n\n${status.pendingChanges} local change${status.pendingChanges === 1 ? ' has' : 's have'} not been uploaded and will stay only here.` : ''}`}
    confirmLabel="Unlink"
    danger
    onconfirm={async () => void (await sync.unlink(ws.id))}
    oncancel={() => (confirmUnlink = false)}
  />
{/if}
{#if confirmDiscard && ws}
  <ConfirmDialog
    title="Discard local changes"
    message={`Reset ${status?.pendingChanges ?? 0} unsynced local change(s) in "${ws.name}" to the cloud version? This cannot be undone. To keep them, unlink the workspace instead.`}
    confirmLabel="Discard"
    danger
    onconfirm={async () => void (await sync.discardPending(ws.id))}
    oncancel={() => (confirmDiscard = false)}
  />
{/if}
