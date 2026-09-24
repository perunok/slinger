<script lang="ts">
  import type { RequestHeader } from '../../../shared/types'
  import { parseSetCookies } from '../../lib/response'
  let { headers }: { headers: RequestHeader[] } = $props()
  const cookies = $derived(parseSetCookies(headers))
</script>

{#if cookies.length === 0}
  <p class="p-4 text-sm text-muted">This response did not set any cookies.</p>
{:else}
  <div class="h-full overflow-auto p-2">
    <table class="w-full border-collapse text-sm" aria-label="Response cookies">
      <thead class="text-left text-xs text-faint">
        <tr>
          {#each ['Name', 'Value', 'Domain', 'Path', 'Expires', 'Flags'] as h (h)}<th class="px-2 py-1 font-normal">{h}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each cookies as c, i (i)}
          <tr class="border-t border-border align-top font-mono text-xs">
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
