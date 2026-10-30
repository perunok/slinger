<script lang="ts">
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import type { RequestTab } from './tabs.svelte'
  let { tab }: { tab: RequestTab } = $props()

  function setTimeout_(v: string) {
    const n = Number(v)
    tab.draft.timeoutMs = v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(n)
  }
</script>

<div class="max-w-md space-y-2 p-3">
  <div class="grid gap-1">
    <label for="req-timeout" class="text-xs text-muted">Request timeout (milliseconds)</label>
    <input id="req-timeout" type="number" min="1" step="100" class="w-48" placeholder="Default" value={tab.draft.timeoutMs ?? ''} oninput={(e) => setTimeout_(e.currentTarget.value)} />
    <p class="text-xs text-faint">Leave empty to use the app default. The request is aborted when the timeout elapses.</p>
  </div>
  <div class="flex items-center gap-1">
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={tab.draft.disableCookies} onchange={(e) => (tab.draft.disableCookies = e.currentTarget.checked)} />
      Disable cookie jar
    </label>
    <InfoTip label="About the cookie jar">
      Normally a request sends the workspace's stored cookies for its URL and keeps the cookies its response sets (like a
      browser). With this on, it does neither. Manage stored cookies with Ctrl+K, Cookies.
    </InfoTip>
  </div>
</div>
