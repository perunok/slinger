<script>
  export let headers;
  function addHeader() {
    headers = [...headers, { key: '', value: '' }];
  }
</script>

<div class="mb-4">
  <h3 class="font-medium mb-2">Headers</h3>
  {#each headers as header, i}
    <div class="flex mb-2">
      <input
        type="text"
        bind:value={header.key}
        placeholder="Key"
        class="flex-1 p-2 border rounded mr-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <input
        type="text"
        bind:value={header.value}
        placeholder="Value"
        class="flex-1 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  {/each}
  <button
    on:click={addHeader}
    class="text-blue-600 hover:underline"
  >
    Add Header
  </button>
</div>