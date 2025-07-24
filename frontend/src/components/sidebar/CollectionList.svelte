<script>
  import { collectionStore } from '../../lib/stores/collectionStore';
</script>

<div class="flex-1 overflow-y-auto">
  {#each $collectionStore as collection}
    <div class="p-2 hover:bg-gray-100 rounded cursor-pointer">
      <span class="font-medium">{collection.name}</span>
      <span class="text-sm text-gray-500">({collection.requests.length} requests)</span>
    </div>
  {/each}
</div>