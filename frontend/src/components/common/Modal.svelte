<script>
  export let isOpen = false;
</script>

{#if isOpen}
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white p-6 rounded shadow-lg max-w-md w-full">
      <slot />
    </div>
  </div>
{/if}