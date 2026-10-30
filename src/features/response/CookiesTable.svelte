<script lang="ts">
  import type { RequestHeader } from '../../../shared/types'
  import { copyText } from '../../app/clipboard'
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import { menuPoint, selectedText } from '../../components/ui/contextMenu'
  import { parseSetCookies } from '../../lib/response'
  import { ui } from '../../app/ui.svelte'
  let { headers }: { headers: RequestHeader[] } = $props()
  const cookies = $derived(parseSetCookies(headers))

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** Right-click on a cookie: copy its name, value or `name=value` (and the selected text, which the menu replaces). */
  function openMenu(e: MouseEvent, c: { name: string; value: string }) {
    e.preventDefault()
    const selection = selectedText()
    menu = {
      ...menuPoint(e),
      items: [
        ...(selection ? [{ label: 'Copy', icon: 'copy', action: () => void copyText(selection) }, { separator: true, label: '' }] : []),
        { label: 'Copy name', action: () => void copyText(c.name, 'Cookie name copied') },
        { label: 'Copy value', action: () => void copyText(c.value, 'Cookie value copied') },
        { label: 'Copy as “name=value”', action: () => void copyText(`${c.name}=${c.value}`, 'Cookie copied') },
      ],
    }
  }
</script>

{#snippet manage()}
  <button type="button" class="text-xs text-accent-text hover:underline" onclick={() => (ui.cookiesOpen = true)}>Manage cookies…</button>
{/snippet}

{#if cookies.length === 0}
  <div class="flex items-center gap-3 p-4">
    <p class="text-sm text-muted">This response did not set any cookies.</p>
    {@render manage()}
  </div>
{:else}
  <div class="h-full overflow-auto p-2">
    <div class="flex justify-end px-2 pb-1">{@render manage()}</div>
    <table class="w-full border-collapse text-sm" aria-label="Response cookies">
      <thead class="text-left text-xs text-faint">
        <tr>
          {#each ['Name', 'Value', 'Domain', 'Path', 'Expires', 'Flags'] as h (h)}<th class="px-2 py-1 font-normal">{h}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each cookies as c, i (i)}
          <tr class="border-t border-border align-top font-mono text-xs" oncontextmenu={(e) => openMenu(e, c)}>
            <td class="px-2 py-1 font-semibold">{c.name}</td>
            <td class="break-all px-2 py-1">{c.value}</td>
            <td class="px-2 py-1">{c.domain ?? ''}</td>
            <td class="px-2 py-1">{c.path ?? ''}</td>
            <td class="px-2 py-1">{c.expires ?? (c.maxAge ? `Max-Age ${c.maxAge}` : 'Session')}</td>
            <td class="px-2 py-1">{[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(', ')}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}
