<script>
  import TabManager from './TabManager.svelte';
  import RequestBuilder from '../request/RequestBuilder.svelte';
  import ResponseViewer from '../request/ResponseViewer.svelte';
</script>

<div class="flex-1 flex flex-col p-4">
  <TabManager />
  <RequestBuilder />
  <ResponseViewer />
</div>