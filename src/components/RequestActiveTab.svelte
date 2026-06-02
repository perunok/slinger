<script lang="ts">
  import JSONEditorWrapper from './JSONEditorWrapper.svelte'
  import PayloadViewer from './PayloadViewer.svelte'
  import RequestTable, { type TableRow } from './RequestTable.svelte'
  import type { PayloadContentType } from '../lib/payloadFormatters'
  import {
    stringifyUnknown,
    type ActiveTab,
    type HeaderDocument,
    type RequestDocument,
    type RequestParam,
    type ResponseExample,
  } from '../lib/requestDocument'
  import type { ApiRequest, Collection } from '../tauri'

  export let activeTab: ActiveTab
  export let bodyDraft: string
  export let bodyIsValid: boolean
  export let description: string
  export let headers: HeaderDocument[]
  export let methodDraft: string
  export let params: RequestParam[]
  export let requestContentType: PayloadContentType
  export let responseExamples: ResponseExample[]
  export let scripts: string
  export let selectedCollection: Collection | null
  export let selectedDocument: RequestDocument
  export let selectedRequest: ApiRequest | null
  export let setBodyDraft: (value: string) => void
  export let urlDraft: string

  $: headerRows = headers.map((header) => ({
    key: header.key ?? '',
    value: header.value ?? '',
    source: header.disabled ? 'disabled' : 'enabled',
  }))
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
    {#if responseExamples.length > 0}
      <div>
        <h3 class="mb-2 font-semibold text-[var(--text)]">Examples</h3>
        <div class="space-y-2">
          {#each responseExamples as response, index (`${response.name}-${index}`)}
            <div class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
              <span class="font-semibold text-[var(--text)]">{response.name ?? 'Example'}</span>
              <span class="ml-3 text-[var(--muted)]">{response.status ?? ''}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{:else if activeTab === 'Params'}
  <RequestTable rows={params} />
{:else if activeTab === 'Authorization'}
  <pre class="h-full overflow-auto p-4 font-mono text-sm text-[#cbd5e1]">
    {stringifyUnknown(selectedDocument.auth)}
  </pre>
{:else if activeTab === 'Headers'}
  <RequestTable rows={headerRows} />
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
