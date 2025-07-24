<script>
  import { historyStore } from '../../lib/stores/historyStore';
</script>

<div class="flex-1 overflow-y-auto">
  {#each $historyStore as request}
    <div class="p-2 hover:bg-gray-100 rounded cursor-pointer">
      <span class="font-medium {request.method === 'GET' ? 'text-green-600' : 'text-blue-600'}">{request.method}</span>
      <span class="text-sm text-gray-500 ml-2">{request.url}</span>
    </div>
  {/each}
</div>