<script lang="ts">
  /** Full-width strip under the top bar when edits are disabled (read-only role / access revoked). */
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { sync } from './syncStore.svelte'

  const status = $derived(sync.current)
  const reason = $derived(sync.blockReason)
  let confirm = $state<'discard' | 'unlink' | null>(null)
</script>

{#if reason && status && app.workspace}
  <div role="status" data-testid="readonly-banner" data-reason={reason} class="flex flex-wrap items-center gap-2 border-b border-warning bg-warning-soft px-3 py-1.5 text-xs">
    <span class="text-warning"><Icon name="lock" size={14} /></span>
    <span class="min-w-0 flex-1">
      {#if reason === 'readOnly'}
        <strong>Read-only workspace.</strong> You have viewer access to {status.remoteName}, so changes cannot be saved. You can still browse and send requests.
      {:else}
        <strong>Cloud access lost.</strong> You can no longer sync {status.remoteName}. Editing is disabled here; your local copy is kept.
      {/if}
      {#if status.pendingChanges > 0}<span class="ml-1">{status.pendingChanges} local change{status.pendingChanges === 1 ? '' : 's'} can't be uploaded.</span>{/if}
    </span>
    {#if status.pendingChanges > 0}<Button size="sm" onclick={() => (confirm = 'discard')}>Discard local changes</Button>{/if}
    <Button size="sm" onclick={() => (confirm = 'unlink')} title="Stop syncing and keep an editable local copy">Unlink and keep as local copy</Button>
    <Button size="sm" variant="ghost" onclick={() => (ui.cloudOpen = true)}>Cloud…</Button>
  </div>
{/if}

{#if confirm && app.workspace}
  {@const ws = app.workspace}
  {#if confirm === 'discard'}
    <ConfirmDialog
      title="Discard local changes"
      message={`Reset ${status?.pendingChanges ?? 0} unsynced local change(s) in "${ws.name}" to the cloud version? This cannot be undone.`}
      confirmLabel="Discard"
      danger
      onconfirm={async () => void (await sync.discardPending(ws.id))}
      oncancel={() => (confirm = null)}
    />
  {:else}
    <ConfirmDialog
      title="Unlink workspace"
      message={`Stop syncing "${ws.name}" and keep it as a normal local workspace? Editing is enabled again.${status && status.pendingChanges > 0 ? `\n\n${status.pendingChanges} local change(s) were never uploaded and stay only here.` : ''}`}
      confirmLabel="Unlink"
      onconfirm={async () => void (await sync.unlink(ws.id))}
      oncancel={() => (confirm = null)}
    />
  {/if}
{/if}
