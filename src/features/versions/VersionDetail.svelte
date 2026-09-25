<script lang="ts">
  import type { CollectionVersion, CollectionVersionDetail } from '../../../shared/types'
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { formatCreated, isPrerelease } from './helpers'
  import SnapshotTree from './SnapshotTree.svelte'
  import VersionCompare from './VersionCompare.svelte'

  interface Props {
    summary: CollectionVersion
    detail: CollectionVersionDetail | null
    loading: boolean
    error: string | null
    versions: CollectionVersion[]
    /** Read-only workspace: restore and delete are disabled. */
    readOnly?: boolean
    onretry: () => void
    onrestore: () => void
    ondelete: () => void
  }
  let { summary, detail, loading, error, versions, readOnly = false, onretry, onrestore, ondelete }: Props = $props()

  let tab = $state('snapshot')
  const tabs = [
    { id: 'snapshot', label: 'Snapshot' },
    { id: 'compare', label: 'Compare' },
  ]
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2">
    <div class="min-w-0">
      <h3 class="flex items-center gap-2 text-sm font-semibold">
        <span class="font-mono">v{summary.version}</span>
        {#if isPrerelease(summary.version)}<span class="text-[10px] font-normal uppercase text-warning">pre-release</span>{/if}
      </h3>
      <p class="text-xs text-muted">
        Created {formatCreated(summary.createdAt)} &middot; {summary.requestCount} request{summary.requestCount === 1 ? '' : 's'},
        {summary.folderCount} folder{summary.folderCount === 1 ? '' : 's'} &middot; immutable
      </p>
      {#if summary.notes}<p class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-sm">{summary.notes}</p>{/if}
    </div>
    <div class="flex gap-1.5">
      <Button icon="history" onclick={onrestore} disabled={readOnly}>Restore...</Button>
      <Button icon="trash" variant="danger" onclick={ondelete} disabled={readOnly}>Delete</Button>
    </div>
  </header>
  <Tabs {tabs} value={tab} onchange={(t) => (tab = t)} label="Version detail" idPrefix="ver-tab" class="px-2" />
  <div id="ver-tab-panel-{tab}" role="tabpanel" aria-labelledby="ver-tab-{tab}" class="min-h-0 flex-1 overflow-auto p-2">
    {#if error}
      <div class="flex items-center gap-2"><InlineError message={error} class="flex-1" /><Button size="sm" onclick={onretry}>Retry</Button></div>
    {:else if loading || !detail}
      <div class="flex items-center gap-2 p-3 text-sm text-muted"><span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-transparent" role="status" aria-label="Loading"></span> Loading version...</div>
    {:else if tab === 'snapshot'}
      <SnapshotTree snapshot={detail.snapshot} />
    {:else}
      <VersionCompare {detail} {versions} />
    {/if}
  </div>
</div>
