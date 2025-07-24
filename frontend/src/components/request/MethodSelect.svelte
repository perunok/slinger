<script>
  export let value;
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
</script>

<select
  bind:value
  class="p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
>
  {#each methods as method}
    <option value={method}>{method}</option>
  {/each}
</select>