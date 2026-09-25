<script lang="ts">
  let { class: cls = '' }: { class?: string } = $props()
</script>

<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-transparent {cls}" role="status" aria-label="Loading"></span>
