<script>
  let tabs = [{ id: 1, name: 'Request 1' }];
  let activeTab = 1;
  function addTab() {
    const newId = tabs.length + 1;
    tabs = [...tabs, { id: newId, name: `Request ${newId}` }];
    activeTab = newId;
  }
</script>

<div class="flex items-center mb-4">
  {#each tabs as tab}
    <button
      class="px-4 py-2 mr-2 rounded-t {activeTab === tab.id ? 'bg-white border-t border-l border-r' : 'bg-gray-200'}"
      on:click={() => (activeTab = tab.id)}
    >
      {tab.name}
    </button>
  {/each}
  <button
    class="text-blue-600 hover:underline"
    on:click={addTab}
  >
    + New Tab
  </button>
</div>