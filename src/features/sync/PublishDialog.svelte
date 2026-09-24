<script lang="ts">
  /**
   * Publish the current workspace: confirm what is uploaded, show progress from the sync status, and offer
   * "Publish a copy" when the cloud says an id is already used by another cloud workspace.
   */
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { duplicateWorkspace, isIdInUse, type CopyProgress } from './duplicateWorkspace'
  import { sync } from './syncStore.svelte'

  const startedFor = app.workspace
  let targetId = $state<string | null>(startedFor?.id ?? null)
  let phase = $state<'confirm' | 'working' | 'copying' | 'done'>('confirm')
  let error = $state<string | null>(null)
  let idClash = $state(false)
  let copy = $state<CopyProgress | null>(null)
  let busy = $state(false)

  const target = $derived(app.workspaces.find((w) => w.id === targetId) ?? null)
  const status = $derived(targetId ? sync.statusOf(targetId) : null)
  const counts = $derived({ collections: app.collections.length, requests: app.requests.length, environments: app.environments.length })
  const progress = $derived(status?.progress)
  const finished = $derived(phase === 'working' && !!status?.linked && status.state !== 'syncing' && !status.initialSyncPending)

  // Watch for the "id in use" rejection once the initial upload has settled.
  $effect(() => {
    if (phase !== 'working' || !status || status.state === 'syncing') return
    if (status.openConflicts > 0 && targetId) void checkClash(targetId)
    else if (finished) phase = 'done'
  })

  async function checkClash(id: string) {
    try {
      const list = await api().listSyncConflicts(id)
      if (list.some((c) => c.kind === 'rejected' && isIdInUse(c.message))) idClash = true
      else phase = 'done'
    } catch {
      phase = 'done'
    }
  }

  async function publish(id = targetId) {
    if (!id) return
    error = null
    idClash = false
    busy = true
    phase = 'working'
    try {
      await sync.publish(id)
    } catch (e) {
      const msg = errorInfo(e).message
      if (isIdInUse(msg)) idClash = true
      else error = msg
      phase = 'confirm'
    } finally {
      busy = false
    }
  }

  /** Unlink the (partly) published original, copy it with fresh ids, and publish the copy. */
  async function publishCopy() {
    if (!startedFor) return
    error = null
    busy = true
    phase = 'copying'
    try {
      if (sync.statusOf(startedFor.id)?.linked) await api().unlinkWorkspace(startedFor.id)
      const ws = await duplicateWorkspace(startedFor.id, `${startedFor.name} (copy)`, (p) => (copy = p))
      await app.refreshWorkspaces()
      await app.selectWorkspace(ws.id)
      targetId = ws.id
      idClash = false
      await publish(ws.id)
      toast.success('Published a copy', `"${ws.name}" is now your active workspace.`)
    } catch (e) {
      error = errorInfo(e).message
      phase = 'confirm'
    } finally {
      busy = false
    }
  }

  const close = () => (ui.publishOpen = false)
</script>

<Dialog title="Publish to cloud" size="md" onclose={close} busy={busy && phase !== 'working'}>
  {#if !startedFor}
    <p class="text-sm text-muted">No workspace is open.</p>
  {:else if phase === 'confirm' || (phase === 'working' && !status?.linked)}
    <div class="space-y-3 text-sm">
      <p>Create a cloud workspace named <strong>{startedFor.name}</strong> and upload everything in it:</p>
      <ul class="list-disc space-y-0.5 pl-5 text-muted" data-testid="publish-counts">
        <li>{counts.collections} collection{counts.collections === 1 ? '' : 's'} with {counts.requests} request{counts.requests === 1 ? '' : 's'} (and their folders and versions)</li>
        <li>{counts.environments} environment{counts.environments === 1 ? '' : 's'} with their variables</li>
      </ul>
      <p class="rounded border border-border bg-raised px-2 py-1.5 text-xs text-muted">
        Secret variable values are never uploaded: teammates see the variable name and set their own value. Request history and settings stay on this device.
      </p>
      {#if idClash}
        <div class="space-y-2 rounded border border-warning bg-warning-soft px-3 py-2 text-xs" role="alert" data-testid="id-clash">
          <p><strong>Some items already exist in another cloud workspace.</strong> This workspace (or part of it) was published before, and the cloud
            does not allow the same item in two workspaces.</p>
          <p>You can publish a copy instead: a new local workspace with fresh ids that has the same content.</p>
        </div>
      {/if}
      <InlineError message={error} />
    </div>
  {:else if phase === 'copying'}
    <div class="space-y-2 text-sm" role="status">
      <p>Creating a copy of “{startedFor.name}”…</p>
      {#if copy}<progress class="h-2 w-full" max={copy.total} value={copy.done} aria-label="Copy progress"></progress><p class="text-xs text-muted">{copy.done} of {copy.total}</p>{/if}
    </div>
  {:else}
    <div class="space-y-3 text-sm" role="status" aria-live="polite">
      {#if phase === 'working'}
        <p>Uploading “{target?.name}”…</p>
        <progress class="h-2 w-full" max={progress?.total ?? undefined} value={progress?.total ? progress.done : undefined} aria-label="Upload progress"></progress>
        <p class="text-xs text-muted">{progress ? `${progress.phase === 'push' ? 'Uploaded' : 'Processed'} ${progress.done}${progress.total !== null ? ` of ${progress.total}` : ''} items` : 'Preparing…'}</p>
        <p class="text-xs text-muted">You can close this window: the upload continues in the background.</p>
      {:else}
        <p class="text-success">Published. “{target?.name}” is now synced with the cloud.</p>
      {/if}
      {#if idClash}
        <div class="space-y-2 rounded border border-warning bg-warning-soft px-3 py-2 text-xs" role="alert" data-testid="id-clash">
          <p><strong>Some items could not be uploaded: they already exist in another cloud workspace.</strong></p>
          <p>Publish a copy to upload everything under fresh ids. The current link is removed first; nothing is deleted anywhere.</p>
        </div>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    {#if phase === 'confirm' || (phase === 'working' && !status?.linked)}
      <Button onclick={close} disabled={busy}>Cancel</Button>
      {#if idClash}<Button variant="primary" loading={busy} onclick={publishCopy}>Publish a copy</Button>
      {:else}<Button variant="primary" icon="upload" loading={busy} onclick={() => publish()}>Publish</Button>{/if}
    {:else}
      {#if idClash}<Button variant="primary" loading={busy} onclick={publishCopy}>Publish a copy</Button>{/if}
      <Button onclick={close}>{phase === 'done' ? 'Done' : 'Close'}</Button>
    {/if}
  {/snippet}
</Dialog>
