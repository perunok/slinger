<script lang="ts">
  import type { CollectionSnapshot } from '../../../shared/types'
  import Icon from '../../components/ui/Icon.svelte'
  import { parseDocument } from '../../lib/request'
  import { dataRows } from '../../lib/kv'
  import type { TreeNode } from '../../lib/tree'
  import { methodColor, snapshotTree } from './helpers'

  let { snapshot }: { snapshot: CollectionSnapshot } = $props()

  const tree = $derived(snapshotTree(snapshot))
  let collapsed = $state(new Set<string>())
  let open = $state(new Set<string>())

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set)
    if (!next.delete(id)) next.add(id)
    return next
  }

  function summary(id: string) {
    const r = snapshot.requests.find((x) => x.id === id)
    if (!r) return null
    const d = parseDocument(r)
    let body = 'none'
    if (d.body.kind === 'raw') body = d.body.raw
    else if (d.body.kind === 'formData') body = dataRows(d.body.formData).map((x) => `${x.key}: ${x.value}`).join('\n')
    else if (d.body.kind === 'urlEncoded') body = dataRows(d.body.urlEncoded).map((x) => `${x.key}: ${x.value}`).join('\n')
    else if (d.body.kind !== 'none') body = d.body.kind
    return {
      method: d.method,
      url: d.url,
      headers: dataRows(d.headers).map((h) => `${h.enabled ? '' : '[off] '}${h.key}: ${h.value}`),
      body,
    }
  }
</script>

{#snippet nodes(list: TreeNode[], depth: number)}
  {#each list as node (node.id)}
    {#if node.kind === 'folder'}
      {@const isOpen = !collapsed.has(node.id)}
      <li role="treeitem" aria-expanded={isOpen} aria-selected="false">
        <button
          type="button"
          class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
          style="padding-left: {depth * 14 + 4}px"
          onclick={() => (collapsed = toggle(collapsed, node.id))}
        >
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
          <Icon name="folder" size={14} />
          <span class="truncate">{node.folder.name}</span>
        </button>
        {#if isOpen}<ul role="group">{@render nodes(node.children, depth + 1)}</ul>{/if}
      </li>
    {:else}
      {@const isOpen = open.has(node.id)}
      <li role="treeitem" aria-selected="false">
        <button
          type="button"
          aria-expanded={isOpen}
          class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
          style="padding-left: {depth * 14 + 4}px"
          onclick={() => (open = toggle(open, node.id))}
        >
          <span class="w-12 shrink-0 font-mono text-[11px] font-semibold" style="color: {methodColor(node.request.method)}">{node.request.method}</span>
          <span class="truncate">{node.request.name}</span>
        </button>
        {#if isOpen}
          {@const s = summary(node.id)}
          {#if s}
            <div class="my-1 rounded border border-border bg-raised p-2 text-xs" style="margin-left: {depth * 14 + 20}px">
              <div class="break-all font-mono"><span style="color: {methodColor(s.method)}">{s.method}</span> {s.url}</div>
              <div class="mt-1 text-muted">Headers</div>
              {#if s.headers.length}
                <pre class="whitespace-pre-wrap break-all font-mono">{s.headers.join('\n')}</pre>
              {:else}<div class="text-faint">none</div>{/if}
              <div class="mt-1 text-muted">Body</div>
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">{s.body}</pre>
            </div>
          {/if}
        {/if}
      </li>
    {/if}
  {/each}
{/snippet}

{#if tree.length === 0}
  <p class="p-3 text-sm text-muted">This version is empty: it has no folders or requests.</p>
{:else}
  <ul role="tree" aria-label="Snapshot contents" class="p-1">{@render nodes(tree, 0)}</ul>
{/if}
