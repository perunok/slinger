<script>
  import CollectionList from './CollectionList.svelte';
  import HistoryList from './HistoryList.svelte';
  let activeTab = 'collections';
</script>

<div class="flex flex-col h-full p-4">
  <h1 class="text-xl font-bold mb-4">Slinger</h1>
  <nav class="mb-4">
    <button
      class="w-full text-left py-2 px-4 rounded {activeTab === 'collections' ? 'bg-blue-100 text-blue-600' : 'text-gray-600'}"
      on:click={() => (activeTab = 'collections')}
    >
      Collections
    </button>
    <button
      class="w-full text-left py-2 px-4 rounded {activeTab === 'history' ? 'bg-blue-100 text-blue-600' : 'text-gray-600'}"
      on:click={() => (activeTab = 'history')}
    >
      History
    </button>
  </nav>
  {#if activeTab === 'collections'}
    <CollectionList />
  {:else}
    <HistoryList />
  {/if}
</div>