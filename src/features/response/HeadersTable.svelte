<script lang="ts">
  import type { RedirectHop, RequestHeader } from '../../../shared/types'
  import { copyText } from '../../app/clipboard'
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import { menuPoint, selectedText } from '../../components/ui/contextMenu'
  /** `redirects`: the redirects followed before this response (shown above the headers). */
  let { headers, redirects = [] }: { headers: RequestHeader[]; redirects?: RedirectHop[] } = $props()

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** Right-click on a header: copy its name, value or the whole line (and the selected text, which the menu replaces). */
  function openMenu(e: MouseEvent, h: RequestHeader) {
    e.preventDefault()
    const selection = selectedText()
    menu = {
      ...menuPoint(e),
      items: [
        ...(selection ? [{ label: 'Copy', icon: 'copy', action: () => void copyText(selection) }, { separator: true, label: '' }] : []),
        { label: 'Copy name', action: () => void copyText(h.key, 'Header name copied') },
        { label: 'Copy value', action: () => void copyText(h.value, 'Header value copied') },
        { label: 'Copy as “Name: value”', action: () => void copyText(`${h.key}: ${h.value}`, 'Header copied') },
      ],
    }
  }
</script>

{#snippet redirectList()}
  {#if redirects.length > 0}
    <section class="mb-2 rounded border border-border p-2" data-testid="redirect-chain" aria-label="Redirects">
      <h4 class="mb-1 text-xs text-faint">Redirected {redirects.length === 1 ? 'once' : `${redirects.length} times`} before this response</h4>
      <ol class="grid gap-0.5 font-mono text-xs">
        {#each redirects as r, i (i)}
          <li class="flex gap-2"><span class="shrink-0 font-semibold">{r.status}</span><span class="text-faint">→</span><span class="break-all">{r.location}</span></li>
        {/each}
      </ol>
    </section>
  {/if}
{/snippet}

{#if headers.length === 0}
  <div class="p-2">{@render redirectList()}</div>
  <p class="p-4 text-sm text-muted">No response headers.</p>
{:else}
  <div class="h-full overflow-auto p-2">
    {@render redirectList()}
    <table class="w-full border-collapse text-sm" aria-label="Response headers">
      <thead class="text-left text-xs text-faint">
        <tr><th class="w-1/3 px-2 py-1 font-normal">Name</th><th class="px-2 py-1 font-normal">Value</th></tr>
      </thead>
      <tbody>
        {#each headers as h, i (i)}
          <tr class="border-t border-border align-top" oncontextmenu={(e) => openMenu(e, h)}>
            <td class="px-2 py-1 font-mono text-xs font-semibold">{h.key}</td>
            <td class="break-all px-2 py-1 font-mono text-xs">{h.value}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}
