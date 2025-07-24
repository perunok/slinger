<script>
  import Sidebar from './components/sidebar/Sidebar.svelte';
  import Workspace from './components/workspace/Workspace.svelte';
</script>

<div class="flex h-screen bg-gray-100">
  <!-- Sidebar -->
  <div class="w-64 bg-white shadow-md">
    <Sidebar />
  </div>

  <!-- Main Workspace -->
  <div class="flex-1 flex flex-col">
    <Workspace />
  </div>
</div>