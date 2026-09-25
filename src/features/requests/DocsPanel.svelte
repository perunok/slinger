<script lang="ts">
  import type { RequestTab } from './tabs.svelte'
  let { tab }: { tab: RequestTab } = $props()
</script>

<div class="flex h-full flex-col gap-1 p-3">
  <label for="req-desc" class="text-xs text-muted">Description (stored with the request and exported to Postman)</label>
  <textarea
    id="req-desc"
    class="min-h-32 flex-1 resize-none"
    value={tab.draft.description}
    oninput={(e) => (tab.draft.description = e.currentTarget.value)}
    placeholder="What does this request do?"
  ></textarea>
</div>
