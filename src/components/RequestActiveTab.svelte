<script lang="ts">
  import JSONEditorWrapper from './JSONEditorWrapper.svelte'
  import PayloadViewer from './PayloadViewer.svelte'
  import RequestAuthorizationTab from './RequestAuthorizationTab.svelte'
  import RequestHeadersTable from './RequestHeadersTable.svelte'
  import RequestTable, { type TableRow } from './RequestTable.svelte'
  import type { PayloadContentType } from '../lib/payloadFormatters'
  import {
    type ActiveTab,
    type HeaderDocument,
    type RequestDocument,
    type RequestParam,
  } from '../lib/requestDocument'
  import type { RequestAuthDocument } from '../lib/authDocument'
  import type { ApiRequest, Collection, EnvironmentVariable } from '../tauri'

  export let activeTab: ActiveTab
  export let bodyDraft: string
  export let bodyIsValid: boolean
  export let description: string
  export let headers: HeaderDocument[]
  export let environmentVariables: EnvironmentVariable[]
  export let methodDraft: string
  export let params: RequestParam[]
  export let requestContentType: PayloadContentType
  export let scripts: string
  export let selectedCollection: Collection | null
  export let selectedDocument: RequestDocument
  export let selectedRequest: ApiRequest | null
  export let setAuth: (auth: RequestAuthDocument | null) => void
  export let setBodyDraft: (value: string) => void
  export let setHeaders: (headers: HeaderDocument[]) => void
  export let urlDraft: string

  $: settingsRows = [
    { key: 'Method', value: methodDraft },
    { key: 'URL', value: urlDraft },
    { key: 'Collection', value: selectedCollection?.name ?? '' },
    { key: 'Request ID', value: selectedRequest?.id ?? '' },
  ] satisfies TableRow[]
</script>

{#if activeTab === 'Docs'}
  <div class="space-y-4 p-4 text-sm text-[var(--muted)]">
    <h2 class="text-lg font-semibold text-[var(--text)]">{selectedRequest?.name}</h2>
    <p class="max-w-3xl whitespace-pre-wrap text-[var(--muted)]">{description || 'No description'}</p>
  </div>
{:else if activeTab === 'Params'}
  <RequestTable rows={params} />
{:else if activeTab === 'Authorization'}
  <RequestAuthorizationTab auth={selectedDocument.auth} {setAuth} {environmentVariables} />
{:else if activeTab === 'Headers'}
  <RequestHeadersTable {headers} {setHeaders} />
{:else if activeTab === 'Scripts'}
  <pre class="h-full overflow-auto p-4 font-mono text-sm text-[#cbd5e1]">
    {scripts || 'No scripts'}
  </pre>
{:else if activeTab === 'Settings'}
  <RequestTable rows={settingsRows} />
{:else if requestContentType === 'json'}
  <JSONEditorWrapper
    value={bodyDraft}
    isValidJson={bodyIsValid}
    onChange={setBodyDraft}
    className="payload-viewer-flush"
  />
{:else}
  <PayloadViewer
    value={bodyDraft}
    contentType={requestContentType}
    emptyText="No request body."
    className="payload-viewer-flush"
    onChange={setBodyDraft}
  />
{/if}
