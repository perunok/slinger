<script lang="ts">
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
</div>
