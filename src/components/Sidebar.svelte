<script lang="ts">
  import CollectionTree from './CollectionTree.svelte'
  import type {
    ApiFolder,
    ApiRequest,
    Collection,
    Environment,
    Workspace,
  } from '../tauri'

  export let handleImportFile: (event: Event) => Promise<void>
  export let handleCreateCollection: (event: SubmitEvent) => Promise<void>
  export let collectionName: string
  export let setCollectionName: (value: string) => void
  export let selectedWorkspace: Workspace | null
  export let environments: Environment[]
  export let selectedEnvironmentId: string | null
  export let setSelectedEnvironmentId: (id: string | null) => void
  export let isTauriRuntime: boolean
  export let error: string | null
  export let loadingCollections: boolean
  export let collections: Collection[]
  export let loadingRequests: boolean
  export let foldersByParent: Map<string, ApiFolder[]>
  export let requestsByFolder: Map<string, ApiRequest[]>
  export let selectedCollectionId: string | null
  export let setSelectedCollectionId: (id: string | null) => void
  export let selectedRequestId: string | null
  export let selectedResponseRequestId: string | null
  export let selectedResponseIndex: number
  export let setSelectedRequestId: (id: string | null) => void
  export let selectResponseExample: (requestId: string, responseIndex: number) => void
  export let openFolderIds: Set<string>
  export let toggleFolder: (folderId: string) => void
  export let handleRenameCollection: (collection: Collection) => Promise<void>
  export let handleDeleteCollection: (collection: Collection) => Promise<void>
  export let handleDeleteRequest: (request: ApiRequest) => Promise<void>
  export let handleExportCollection: (collection: Collection) => Promise<void>

  let environmentsExpanded = true
  let importInputRef: HTMLInputElement

  $: environmentCountLabel = `${environments.length} ${environments.length === 1 ? 'env' : 'envs'}`

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

</script>

<aside class="flex shrink-0 flex-col min-h-0 h-full border-r border-[var(--border)] bg-[var(--bg-alt)]" style="width: 100%;">
  <div class="border-b border-[var(--border)] p-3">
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-xs font-bold uppercase tracking-wide text-[var(--text)]">Collections</h1>
      <button class="toolbar-button" on:click={() => importInputRef.click()} disabled={!selectedWorkspace} title="Import Postman collection">Import</button>
      <input bind:this={importInputRef} type="file" accept="application/json,.json" class="hidden" on:change={handleImportFile} />
    </div>

    <form class="mt-3 flex gap-2" on:submit={handleCreateCollection}>
      <input
        value={collectionName}
        on:input={(event) => setCollectionName(inputValue(event))}
        placeholder="New collection"
        class="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
        disabled={!selectedWorkspace}
      />
      <button class="primary-button h-8" disabled={!collectionName.trim() || !selectedWorkspace}>+</button>
    </form>

    {#if selectedWorkspace}
      <p class="mt-3 truncate text-xs text-[#8c8c8c]">Workspace: {selectedWorkspace.name}</p>
    {/if}
    {#if !isTauriRuntime}
      <p class="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">Browser preview mode: data is stored in localStorage. Run the desktop app for SQLite.</p>
    {/if}
    {#if error}
      <p class="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">{error}</p>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-2 py-2">
    {#if loadingCollections}
      <p class="px-2 py-3 text-sm text-[var(--muted)]">Loading collections...</p>
    {:else if collections.length === 0}
      <div class="px-2 py-4 text-sm text-[#9a9a9a]">Create a collection or import the Postman JSON sample.</div>
    {:else}
      <CollectionTree
        {collections}
        {foldersByParent}
        {handleDeleteCollection}
        {handleExportCollection}
        {handleRenameCollection}
        {loadingRequests}
        {openFolderIds}
        {requestsByFolder}
        {selectedCollectionId}
        {selectedRequestId}
        {selectedResponseRequestId}
        {selectedResponseIndex}
        {setSelectedCollectionId}
        {setSelectedRequestId}
        {selectResponseExample}
        {toggleFolder}
        {handleDeleteRequest}
      />
    {/if}
  </div>

  <div class="border-t border-[var(--border)]">
    <div class="border-b border-[var(--border)]">
      <button
        type="button"
        on:click={() => (environmentsExpanded = !environmentsExpanded)}
        class="flex h-10 w-full items-center justify-between gap-2 px-3 text-left text-xs font-bold uppercase text-[var(--text)] hover:bg-[var(--panel)]"
      >
        <div class="flex items-center gap-2">
          <span class="w-3 shrink-0 text-[var(--muted)]">{environmentsExpanded ? 'v' : '>'}</span>
          <span>Environments</span>
        </div>
        <span class="text-[10px] font-medium text-[var(--muted)]">
          {environmentCountLabel}
        </span>
      </button>

      {#if environmentsExpanded}
        <div class="px-2 py-2">
          {#if !selectedWorkspace}
            <p class="px-2 py-2 text-xs text-[var(--muted)]">Select a workspace first.</p>
          {:else if environments.length === 0}
            <p class="px-2 py-2 text-xs text-[var(--muted)]">No environments available.</p>
          {:else}
            <div class="max-h-48 space-y-1 overflow-auto">
              {#each environments as environment (environment.id)}
                <button
                  type="button"
                  class={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                    environment.id === selectedEnvironmentId
                      ? 'bg-[var(--surface)] text-[var(--text)]'
                      : 'text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]'
                  }`}
                  title={environment.name}
                  aria-pressed={environment.id === selectedEnvironmentId}
                  on:click={() => setSelectedEnvironmentId(environment.id)}
                >
                  <span class="min-w-0 flex-1 truncate">{environment.name}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#each ['Specs', 'Flows'] as label}
      <button class="flex h-8 w-full items-center gap-2 border-b border-[var(--border)] px-3 text-left text-xs font-bold uppercase text-[var(--muted)]">
        <span>&gt;</span>
        {label}
      </button>
    {/each}
  </div>
</aside>
