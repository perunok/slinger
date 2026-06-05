<script lang="ts">
  import PayloadViewer from './PayloadViewer.svelte'
  import RequestAuthorizationTab from './RequestAuthorizationTab.svelte'
  import RequestHeadersTable from './RequestHeadersTable.svelte'
  import RequestTable, { type TableRow } from './RequestTable.svelte'
  import CodeSnippetTab from './CodeSnippetTab.svelte'
  import type { PayloadContentType } from '../lib/payloadFormatters'
  import {
    type ActiveTab,
    type HeaderDocument,
    type RequestDocument,
    type RequestParam,
    type RequestScriptState,
    type ScriptListener,
  } from '../lib/requestDocument'
  import type { RequestAuthDocument } from '../lib/authDocument'
  import type { ApiRequest, Collection, EnvironmentVariable } from '../tauri'
  import type { SnippetRequest } from '../lib/codeSnippets'

  type ScriptNavItem = {
    id: ScriptListener
    label: string
    caption: string
  }

  type JSONEditorWrapperComponent = typeof import('./JSONEditorWrapper.svelte').default

  const SCRIPT_NAV_ITEMS: ScriptNavItem[] = [
    { id: 'prerequest', label: 'Pre-request', caption: 'Before send' },
    { id: 'test', label: 'Post-request', caption: 'After response' },
  ]

  export let activeTab: ActiveTab
  export let bodyDraft: string
  export let bodyIsValid: boolean
  export let description: string
  export let headers: HeaderDocument[]
  export let environmentVariables: EnvironmentVariable[]
  export let methodDraft: string
  export let params: RequestParam[]
  export let requestContentType: PayloadContentType
  export let scripts: RequestScriptState
  export let selectedCollection: Collection | null
  export let selectedDocument: RequestDocument
  export let selectedRequest: ApiRequest | null
  export let setAuth: (auth: RequestAuthDocument | null) => void
  export let setBodyDraft: (value: string) => void
  export let setHeaders: (headers: HeaderDocument[]) => void
  export let setScript: (listener: ScriptListener, value: string) => void
  export let urlDraft: string
  export let builtRequest: SnippetRequest | null = null

  let activeScriptNav: ScriptListener = 'prerequest'
  let jsonEditorWrapperComponent: JSONEditorWrapperComponent | null = null
  let jsonEditorWrapperPromise: Promise<void> | null = null

  function textAreaValue(event: Event): string {
    return (event.currentTarget as HTMLTextAreaElement).value
  }

  async function loadJsonEditorWrapper() {
    if (jsonEditorWrapperComponent) return

    if (!jsonEditorWrapperPromise) {
      jsonEditorWrapperPromise = import('./JSONEditorWrapper.svelte')
        .then((module) => {
          jsonEditorWrapperComponent = module.default
        })
        .finally(() => {
          jsonEditorWrapperPromise = null
        })
    }

    await jsonEditorWrapperPromise
  }

  $: settingsRows = [
    { key: 'Method', value: methodDraft },
    { key: 'URL', value: urlDraft },
    { key: 'Collection', value: selectedCollection?.name ?? '' },
    { key: 'Request ID', value: selectedRequest?.id ?? '' },
  ] satisfies TableRow[]
  $: if (activeTab === 'Body' && requestContentType === 'json' && !jsonEditorWrapperComponent) {
    void loadJsonEditorWrapper()
  }
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
  <div class="flex h-full min-h-0 bg-[var(--bg)]">
    <aside class="flex w-40 shrink-0 flex-col gap-2 border-r border-[var(--border)] bg-[var(--surface)] p-2">
      {#each SCRIPT_NAV_ITEMS as item (item.id)}
        <button
          type="button"
          class={`rounded-xl border px-3 py-3 text-left transition-colors ${
            activeScriptNav === item.id
              ? 'border-[#5a8fff] bg-[#5a8fff1a] text-[var(--text)]'
              : 'border-transparent bg-transparent text-[var(--muted)] hover:border-[var(--border)] hover:bg-[var(--panel)] hover:text-[var(--text)]'
          }`}
          on:click={() => (activeScriptNav = item.id)}
        >
          <div class="text-sm font-semibold">{item.label}</div>
          <div class="mt-1 text-xs opacity-80">{item.caption}</div>
        </button>
      {/each}
    </aside>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="border-b border-[var(--border)] px-4 py-3">
        <div class="text-sm font-semibold text-[var(--text)]">
          {activeScriptNav === 'prerequest' ? 'Pre-request script' : 'Post-request script'}
        </div>
        <p class="mt-1 text-xs text-[var(--muted)]">
          {activeScriptNav === 'prerequest'
            ? 'Runs before the request is built and sent. Use it to prepare environment variables.'
            : 'Runs after a response is received. Use it to inspect the payload and store values.'}
        </p>
      </div>

      <textarea
        class="min-h-0 flex-1 resize-none bg-[var(--bg)] p-4 font-mono text-sm leading-6 text-[#cbd5e1] outline-none"
        spellcheck="false"
        aria-label={activeScriptNav === 'prerequest' ? 'Pre-request script' : 'Post-request script'}
        value={scripts[activeScriptNav]}
        on:input={(event) => setScript(activeScriptNav, textAreaValue(event))}
      />
    </div>
  </div>
{:else if activeTab === 'Settings'}
  <RequestTable rows={settingsRows} />
{:else if activeTab === 'Code'}
  <CodeSnippetTab {builtRequest} />
{:else if requestContentType === 'json'}
  {#if jsonEditorWrapperComponent}
    <svelte:component
      this={jsonEditorWrapperComponent}
      value={bodyDraft}
      isValidJson={bodyIsValid}
      onChange={setBodyDraft}
      className="payload-viewer-flush"
    />
  {:else}
    <div class="flex h-full items-center justify-center bg-[var(--bg)] px-4 text-sm text-[var(--muted)]">
      Loading JSON editor...
    </div>
  {/if}
{:else}
  <PayloadViewer
    value={bodyDraft}
    contentType={requestContentType}
    emptyText="No request body."
    className="payload-viewer-flush"
    onChange={setBodyDraft}
  />
{/if}
