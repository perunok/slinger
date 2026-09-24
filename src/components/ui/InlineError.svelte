<script lang="ts">
  let { message, class: cls = '' }: { message: string | null | undefined; class?: string } = $props()
</script>

{#if message}
  <p role="alert" class="rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs text-danger {cls}">{message}</p>
{/if}
