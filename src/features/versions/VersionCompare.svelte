<script lang="ts">
  import type { CollectionSnapshot, CollectionVersion, CollectionVersionDetail } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { diffSnapshots, snapshotFromCollection } from '../../lib/versionDiff'
  import DiffView from './DiffView.svelte'

  interface Props {
    detail: CollectionVersionDetail
    versions: CollectionVersion[]
  }
  let { detail, versions }: Props = $props()

  /** 'current' or another version id. */
  let against = $state('current')
  let other = $state<CollectionVersionDetail | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let seq = 0

  const others = $derived(versions.filter((v) => v.id !== detail.id))

  $effect(() => {
    const id = against
    detail.id // re-run (and reset) when another version is selected
    error = null
    if (id === 'current') {
      other = null
      return
    }
    void load(id)
  })
  $effect(() => {
    if (against !== 'current' && detail.id === against) against = 'current'
  })

  async function load(id: string) {
    const mine = ++seq
    loading = true
    other = null
    try {
      const d = await api().getCollectionVersion(id)
      if (mine === seq) other = d
    } catch (e) {
      if (mine === seq) error = errorInfo(e).message
    } finally {
      if (mine === seq) loading = false
    }
  }

  const target = $derived.by((): { snapshot: CollectionSnapshot; label: string } | null => {
    if (against === 'current') {
      const c = app.collections.find((x) => x.id === detail.collectionId)
      if (!c) return null
      return {
        snapshot: snapshotFromCollection(c, app.foldersOf(c.id), app.requestsOf(c.id)),
        label: 'current collection',
      }
    }
    return other ? { snapshot: other.snapshot, label: `v${other.version}` } : null
  })
  const diff = $derived(target ? diffSnapshots(detail.snapshot, target.snapshot) : null)
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center gap-2 text-sm">
    <label for="cmp-target" class="text-xs font-medium">Compare v{detail.version} against</label>
    <select
      id="cmp-target"
      bind:value={against}
      class="h-8 rounded border border-border bg-raised px-2 text-sm outline-none focus:ring-2 focus:ring-accent"
    >
      <option value="current">Current collection</option>
      {#each others as v (v.id)}<option value={v.id}>v{v.version}</option>{/each}
    </select>
    {#if loading}<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-transparent" role="status" aria-label="Loading"></span>{/if}
  </div>
  {#if against === 'current'}
    <p class="text-xs text-faint">
      "Current collection" is the last saved state. Unsaved changes in open editor tabs are not included.
    </p>
  {/if}
  <InlineError message={error} />
  {#if diff && target}
    <DiffView {diff} fromLabel="v{detail.version}" toLabel={target.label} />
  {:else if !loading && !error && against === 'current'}
    <p class="text-sm text-muted">The live collection could not be found.</p>
  {/if}
</div>
