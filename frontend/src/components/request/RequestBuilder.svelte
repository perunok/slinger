<script>
  import MethodSelect from './MethodSelect.svelte';
  import HeadersEditor from './HeadersEditor.svelte';
  import BodyEditor from './BodyEditor.svelte';
  import { requestStore } from '../../lib/stores/requestStore';
  import { addToHistory } from '../../lib/stores/historyStore';
  import { mockSendRequest } from '../../lib/api/mockData';

  let url = '';
  let method = 'GET';
  let headers = [{ key: '', value: '' }];
  let body = '';

  async function sendRequest() {
    const request = { method, url, headers, body };
    const response = await mockSendRequest(request);
    requestStore.set({ request, response });
    addToHistory(request);
  }
</script>

<div class="bg-white p-4 rounded shadow-md mb-4">
  <div class="flex items-center mb-4">
    <MethodSelect bind:value={method} />
    <input
      type="text"
      bind:value={url}
      placeholder="Enter API URL"
      class="flex-1 mx-2 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    <button
      on:click={sendRequest}
      class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
    >
      Send
    </button>
  </div>
  <HeadersEditor bind:headers />
  {#if method !== 'GET'}
    <BodyEditor bind:body />
  {/if}
</div>