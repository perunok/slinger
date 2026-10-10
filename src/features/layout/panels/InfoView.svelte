<script lang="ts">
  /** Right panel > Info: facts about the active request (ids, location, times, version, sync). */
  import { app } from '../../../app/state.svelte'
  import { mcpDisplayUrl, type McpTransport } from '../../../lib/mcpRequest'
  import type { RequestTab } from '../../requests/tabs.svelte'
  import { sync } from '../../sync/syncStore.svelte'
  import PanelEmpty from './PanelEmpty.svelte'

  let { tab }: { tab: RequestTab | null } = $props()

  const request = $derived(tab ? app.requestById(tab.requestId) : undefined)
  const collection = $derived(tab?.collectionId ? app.collections.find((c) => c.id === tab.collectionId) : undefined)
  /** Collection / Folder / Subfolder. */
  const location = $derived.by(() => {
    if (!tab || !collection) return null
    const parts: string[] = []
    let folderId = tab.folderId
    for (let guard = 0; folderId && guard < 64; guard++) {
      const f = app.folders.find((x) => x.id === folderId)
      if (!f) break
      parts.unshift(f.name)
      folderId = f.parentFolderId
    }
    return [collection.name, ...parts].join(' / ')
  })
  const mcp = $derived(tab?.draft.mcp)
  const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = { http: 'Streamable HTTP', sse: 'SSE (legacy)', stdio: 'Command (stdio)' }
  const when = (s: number | undefined) => (s ? new Date(s * 1000).toLocaleString() : '—')
  const state = $derived(!tab ? '' : !tab.requestId ? 'Not saved yet' : tab.dirty ? 'Unsaved changes' : 'Saved')
  const cloud = $derived.by(() => {
    const s = sync.current
    if (!s?.linked) return 'Local only (this workspace is not synced)'
    return `${s.remoteName ? `Cloud workspace “${s.remoteName}”` : 'Synced workspace'}: ${sync.chip.label}`
  })
</script>

<div class="p-3 text-sm" data-testid="panel-info">
  {#if !tab}
    <PanelEmpty><p>Open a request to see its details.</p></PanelEmpty>
  {:else}
    <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {#if tab.example}
        <dt class="text-muted">Example</dt>
        <dd class="break-words">{tab.title}</dd>
      {/if}
      <dt class="text-muted">Request</dt>
      <dd class="break-words">{tab.draft.name || 'Untitled Request'}</dd>
      <dt class="text-muted">Method</dt>
      <dd class="font-mono">{tab.draft.method}</dd>
      {#if mcp}
        <dt class="text-muted">Transport</dt>
        <dd>{MCP_TRANSPORT_LABELS[mcp.transport]}</dd>
        <dt class="text-muted">{mcp.transport === 'stdio' ? 'Command' : 'Server'}</dt>
        <dd class="break-all font-mono">{mcpDisplayUrl(tab.draft) || '—'}</dd>
      {:else}
        <dt class="text-muted">URL</dt>
        <dd class="break-all font-mono">{tab.draft.url || '—'}</dd>
      {/if}
      <dt class="text-muted">Location</dt>
      <dd class="break-words">{location ?? 'Not in a collection'}</dd>
      <dt class="text-muted">State</dt>
      <dd>{state}</dd>
      <dt class="text-muted">ID</dt>
      <dd class="select-all break-all font-mono" data-testid="info-id">{tab.requestId ?? '—'}</dd>
      <dt class="text-muted">Created</dt>
      <dd>{when(request?.createdAt)}</dd>
      <dt class="text-muted">Updated</dt>
      <dd>{when(request?.updatedAt)}</dd>
      <dt class="text-muted">Version</dt>
      <dd>{request?.version ?? '—'}</dd>
      <dt class="text-muted">Sync</dt>
      <dd class="break-words">{cloud}</dd>
    </dl>
  {/if}
</div>
