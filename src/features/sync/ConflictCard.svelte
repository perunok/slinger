<script lang="ts">
  /** Detail of ONE conflict: side-by-side diff per field group, merge choices and the resolution buttons. */
  import type { SyncConflict, SyncResolution } from '../../../shared/types'
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { suggestBumps, validateVersion } from '../../lib/semver'
  import { buildGroupDiffs } from './conflictDiff'
  import { KIND_HELP, KIND_TITLE, mergeReady, pathText, resolutionUi } from './conflictUi'
  import DiffPane from './DiffPane.svelte'
  import { sync } from './syncStore.svelte'

  interface Props {
    conflict: SyncConflict
    /** Called after a successful resolution. */
    onresolved?: () => void
  }
  let { conflict, onresolved }: Props = $props()

  const diffs = $derived(buildGroupDiffs(conflict))
  const open = $derived(conflict.status === 'open')
  const mergeGroups = $derived(conflict.groups.filter((g) => g.conflicting))
  let choices = $state<Partial<Record<string, 'local' | 'remote'>>>({})
  let newVersion = $state('')
  let busy = $state<SyncResolution | null>(null)
  let error = $state<string | null>(null)
  let merging = $state(false)

  const versionCheck = $derived(newVersion.trim() ? validateVersion(newVersion.trim(), []) : null)
  const local = $derived(conflict.kind === 'local_deleted')

  async function resolve(resolution: SyncResolution) {
    if (busy) return
    error = null
    busy = resolution
    try {
      await sync.resolve({
        conflictId: conflict.id,
        resolution,
        ...(resolution === 'merge' ? { fieldChoices: $state.snapshot(choices) as Record<string, 'local' | 'remote'> } : {}),
        ...(resolution === 'duplicate' && conflict.kind === 'immutable_clash' ? { newVersion: newVersion.trim() } : {}),
      })
      onresolved?.()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = null
    }
  }

  function suggest() {
    if (!newVersion) newVersion = suggestBumps(['1.0.0']).patch
  }
</script>

<article class="flex min-w-0 flex-col gap-3" aria-labelledby="cc-title-{conflict.id}" data-testid="conflict-card">
  <header class="space-y-1">
    <div class="flex flex-wrap items-center gap-2">
      <h3 id="cc-title-{conflict.id}" class="truncate text-sm font-semibold">{conflict.label}</h3>
      <span class="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning">{KIND_TITLE[conflict.kind]}</span>
      <span class="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">{conflict.entityType.replace('_', ' ')}</span>
    </div>
    <p class="break-words text-xs text-muted" aria-label="Location">{pathText(conflict.path, conflict.label)}</p>
    <p class="text-xs">{conflict.message || KIND_HELP[conflict.kind]}</p>
    {#if conflict.message && conflict.message !== KIND_HELP[conflict.kind]}<p class="text-xs text-muted">{KIND_HELP[conflict.kind]}</p>{/if}
  </header>

  {#each diffs as g (g.group)}
    <section class="space-y-1.5" aria-label="{g.label} comparison">
      <div class="flex items-center gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</h4>
        {#if g.conflicting}<span class="rounded bg-warning-soft px-1.5 text-[10px] text-warning">conflict</span>{/if}
        {#if open && merging && g.conflicting}
          <fieldset class="ml-auto flex items-center gap-3 text-xs">
            <legend class="sr-only">Which value to keep for {g.label}</legend>
            <label class="flex items-center gap-1"><input type="radio" name="merge-{conflict.id}-{g.group}" checked={choices[g.group] === 'local'} onchange={() => (choices[g.group] = 'local')} /> Keep mine</label>
            <label class="flex items-center gap-1"><input type="radio" name="merge-{conflict.id}-{g.group}" checked={choices[g.group] === 'remote'} onchange={() => (choices[g.group] = 'remote')} /> Keep cloud</label>
          </fieldset>
        {/if}
      </div>
      {#each g.rows as row (row.key)}
        <DiffPane {row} deletedLocal={local ? '(deleted here)' : '(missing)'} deletedRemote={conflict.kind === 'remote_deleted' ? '(deleted in the cloud)' : '(missing)'} />
      {/each}
    </section>
  {/each}
  {#if diffs.length === 0}
    <p class="rounded border border-border bg-raised p-2 text-xs text-muted">No field-level details are available for this item.</p>
  {/if}

  {#if open && conflict.allowedResolutions.includes('duplicate') && conflict.kind === 'immutable_clash'}
    <div class="grid gap-1">
      <label for="nv-{conflict.id}" class="text-xs text-muted">New version number for my copy</label>
      <input id="nv-{conflict.id}" type="text" class="field max-w-40 font-mono" placeholder="1.0.1" bind:value={newVersion} onfocus={suggest} aria-invalid={versionCheck && !versionCheck.ok ? true : undefined} />
      {#if versionCheck && !versionCheck.ok}<p class="text-xs text-danger">{versionCheck.reason}</p>{/if}
    </div>
  {/if}

  <InlineError message={error} />

  {#if open}
    <div class="flex flex-wrap items-center gap-2 border-t border-border pt-2" role="group" aria-label="Resolve this conflict">
      {#each conflict.allowedResolutions as r (r)}
        {@const ui = resolutionUi(conflict.kind, r)}
        {#if r === 'merge'}
          {#if !merging}
            <Button title={ui.description} onclick={() => (merging = true)} disabled={!!busy}>Choose per part…</Button>
          {:else}
            <Button variant="primary" title={ui.description} loading={busy === 'merge'} disabled={!!busy || !mergeReady(conflict, choices)} onclick={() => resolve('merge')}>Apply choices</Button>
            <Button variant="ghost" onclick={() => (merging = false)} disabled={!!busy}>Cancel merge</Button>
          {/if}
        {:else}
          <Button
            variant={ui.variant}
            title={ui.description}
            loading={busy === r}
            disabled={(!!busy && busy !== r) || (r === 'duplicate' && conflict.kind === 'immutable_clash' && !(versionCheck && versionCheck.ok))}
            onclick={() => resolve(r)}>{ui.label}</Button>
        {/if}
      {/each}
    </div>
    <ul class="list-disc space-y-0.5 pl-5 text-[11px] text-muted">
      {#each conflict.allowedResolutions.filter((r) => r !== 'merge') as r (r)}<li><strong class="text-fg">{resolutionUi(conflict.kind, r).label}:</strong> {resolutionUi(conflict.kind, r).description}</li>{/each}
    </ul>
  {:else}
    <p class="border-t border-border pt-2 text-xs text-muted" role="status">
      {conflict.status === 'auto_resolved' ? 'Resolved automatically.' : `Resolved${conflict.resolution ? ` (${resolutionUi(conflict.kind, conflict.resolution).label.toLowerCase()})` : ''}.`}
    </p>
  {/if}
</article>
