<script lang="ts">
  /** Empty state of a right-panel view. */
  import type { Snippet } from 'svelte'
  let { children }: { children: Snippet } = $props()
</script>

<div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center text-sm text-muted" data-testid="panel-empty">
  {@render children()}
</div>
