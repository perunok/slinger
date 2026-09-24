<script lang="ts">
  /**
   * Link an existing cloud workspace: pick it, see what will happen (union/dedupe, read-only, empty remote),
   * and choose between merging into the current workspace and downloading into a new local workspace.
   */
  import { onMount } from 'svelte'
  import type { RemoteWorkspacePreview } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { linkPlan, remoteContentSummary } from './linkPlan'
  import { sync } from './syncStore.svelte'

  let remoteId = $state<string | null>(ui.linkOpen?.remoteId ?? null)
  let preview = $state<RemoteWorkspacePreview | null>(null)
  let previewError = $state<string | null>(null)
  let previewing = $state(false)
  let mode = $state<'merge' | 'new'>('new')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let seq = 0

  const ws = app.workspace
  const localLinked = !!(ws && sync.statusOf(ws.id)?.linked)
  const counts = { collections: app.collections.length, requests: app.requests.length, environments: app.environments.length }
  const candidates = $derived(sync.remotes.filter((r) => !r.linkedLocalWorkspaceId))
  const plan = $derived(linkPlan({ preview, localHasContent: counts.collections + counts.requests + counts.environments > 0, localLinked, hasLocalWorkspace: !!ws }))

  onMount(() => {
    if (sync.remotes.length === 0) void sync.loadRemotes()
  })

  $effect(() => {
    const id = remoteId
    if (!id) {
      preview = null
      return
    }
    const mine = ++seq
    previewing = true
    previewError = null
    sync
      .preview(id)
      .then((p) => {
        if (mine !== seq) return
        preview = p
      })
      .catch((e) => {
        if (mine === seq) {
          preview = null
          previewError = errorInfo(e).message
        }
      })
      .finally(() => {
        if (mine === seq) previewing = false
      })
  })
  // Follow the recommended mode whenever the plan changes.
  $effect(() => {
    mode = plan.mode
  })

  async function submit() {
    if (!remoteId) return
    busy = true
    error = null
    try {
      const res = await sync.link({ remoteWorkspaceId: remoteId, localWorkspaceId: mode === 'merge' && ws ? ws.id : null })
      await app.refreshWorkspaces()
      if (res.workspace.id !== app.workspaceId) await app.selectWorkspace(res.workspace.id)
      toast.success('Linked to the cloud', mode === 'new' ? `Downloading into “${res.workspace.name}”…` : 'Merging and syncing in the background…')
      ui.linkOpen = null
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }
</script>

<Dialog title="Link a cloud workspace" size="md" onclose={() => (ui.linkOpen = null)} {busy}>
  <div class="space-y-3 text-sm">
    <div class="grid gap-1">
      <label for="link-remote" class="text-xs text-muted">Cloud workspace</label>
      <select id="link-remote" bind:value={remoteId} disabled={busy} data-autofocus>
        <option value={null}>Choose…</option>
        {#each candidates as r (r.id)}<option value={r.id}>{r.name} ({r.role})</option>{/each}
        {#if remoteId && !candidates.some((c) => c.id === remoteId)}<option value={remoteId}>{preview?.name ?? 'Selected workspace'}</option>{/if}
      </select>
      {#if sync.remotesError}<InlineError message={sync.remotesError} />{:else if candidates.length === 0 && !sync.remotesLoading}<p class="text-xs text-muted">Every cloud workspace is already linked on this device.</p>{/if}
    </div>

    {#if previewing}
      <p class="text-xs text-muted" role="status">Looking at the cloud workspace…</p>
    {:else if previewError}
      <InlineError message={previewError} />
    {:else if preview}
      <div class="space-y-2" data-testid="link-preview">
        <p class="text-xs text-muted">
          <strong class="text-fg">{preview.name}</strong>: your role: {preview.role === 'viewer' ? 'viewer (read-only)' : preview.role}.
          {#if preview.remoteEmpty === true}It is empty.{:else if preview.remoteEmpty === false}It already has content{#if remoteContentSummary(preview.counts)}: {remoteContentSummary(preview.counts)}{/if}.{:else}Its content could not be checked right now.{/if}
        </p>
        {#if plan.canMerge}
          <fieldset class="space-y-1.5">
            <legend class="text-xs text-muted">Where should it go?</legend>
            <label class="flex items-start gap-2"><input type="radio" name="link-mode" value="new" bind:group={mode} disabled={busy} class="mt-1" />
              <span><strong>Download into a new workspace</strong>{#if plan.mode === 'new'}&nbsp;<span class="text-xs text-success">(recommended)</span>{/if}<br /><span class="text-xs text-muted">Keeps “{ws?.name}” untouched and creates a team workspace with the cloud content.</span></span></label>
            <label class="flex items-start gap-2"><input type="radio" name="link-mode" value="merge" bind:group={mode} disabled={busy} class="mt-1" />
              <span><strong>Merge into “{ws?.name}”</strong>{#if plan.mode === 'merge'}&nbsp;<span class="text-xs text-success">(recommended)</span>{/if}<br /><span class="text-xs text-muted">Uploads what is here ({counts.collections} collection{counts.collections === 1 ? '' : 's'}, {counts.requests} request{counts.requests === 1 ? '' : 's'}, {counts.environments} environment{counts.environments === 1 ? '' : 's'}) and downloads what is there.</span></span></label>
          </fieldset>
        {:else}
          <p class="rounded border border-border bg-raised px-2 py-1.5 text-xs text-muted" data-testid="link-forced">{plan.reason}</p>
        {/if}
        {#if mode === 'merge' && plan.canMerge}
          <div class="rounded border border-warning bg-warning-soft px-2 py-1.5 text-xs" data-testid="merge-warning">
            <p><strong>What merging does:</strong></p>
            <ul class="list-disc pl-5">
              <li>Collections, folders and requests from both sides are kept side by side. Nothing is merged by name, so the same request may appear twice if it exists in both places.</li>
              <li>Environments with the same name are combined, and variables with the same name are matched. For a plain variable that differs, the cloud value wins.</li>
              <li>Secret values stay on this device; secret variables that only exist in the cloud will ask for a value here.</li>
            </ul>
          </div>
        {/if}
      </div>
    {/if}
    <InlineError message={error} />
  </div>
  {#snippet footer()}
    <Button onclick={() => (ui.linkOpen = null)} disabled={busy}>Cancel</Button>
    <Button variant="primary" icon="link" loading={busy} disabled={!remoteId || !preview || previewing} onclick={submit}>{mode === 'new' || !plan.canMerge ? 'Link and download' : 'Link and merge'}</Button>
  {/snippet}
</Dialog>
