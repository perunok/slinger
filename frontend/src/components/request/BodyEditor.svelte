<script>
  export let body;
</script>

<div class="mb-4">
  <h3 class="font-medium mb-2">Body</h3>
  <textarea
    bind:value={body}
    placeholder="Enter request body (e.g., JSON)"
    class="w-full h-32 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
  ></textarea>
</div>