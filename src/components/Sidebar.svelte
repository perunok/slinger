<script lang="ts">
  import CollectionTree from './CollectionTree.svelte'
  import type {
    ApiFolder,
    ApiRequest,
    Collection,
    Environment,
    EnvironmentVariable,
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
  export let environmentName: string
  export let setEnvironmentName: (value: string) => void
  export let handleCreateEnvironment: (event: SubmitEvent) => Promise<void>
  export let environmentVariables: EnvironmentVariable[]
  export let variableKey: string
  export let setVariableKey: (value: string) => void
  export let variableValue: string
  export let setVariableValue: (value: string) => void
  export let handleSaveVariable: (event: SubmitEvent) => Promise<void>
  export let handleEditVariable: (variable: EnvironmentVariable) => void
  export let handleDeleteVariable: (variable: EnvironmentVariable) => Promise<void>
  export let isTauriRuntime: boolean
  export let error: string | null
  export let notice: string | null
  export let loadingCollections: boolean
  export let collections: Collection[]
  export let loadingRequests: boolean
  export let foldersByParent: Map<string, ApiFolder[]>
  export let requestsByFolder: Map<string, ApiRequest[]>
  export let selectedCollectionId: string | null
  export let setSelectedCollectionId: (id: string | null) => void
  export let selectedRequestId: string | null
  export let setSelectedRequestId: (id: string | null) => void
  export let openFolderIds: Set<string>
  export let toggleFolder: (folderId: string) => void
  export let handleRenameCollection: (collection: Collection) => Promise<void>
  export let handleDeleteCollection: (collection: Collection) => Promise<void>

  let environmentsExpanded = true
  let importInputRef: HTMLInputElement

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }
</script>

<aside class="flex w-[385px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-alt)]">
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
    {#if notice}
      <p class="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">{notice}</p>
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
        {handleRenameCollection}
        {loadingRequests}
        {openFolderIds}
        {requestsByFolder}
        {selectedCollectionId}
        {selectedRequestId}
        {setSelectedCollectionId}
        {setSelectedRequestId}
        {toggleFolder}
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
          {environmentVariables.length} vars
        </span>
      </button>

      {#if environmentsExpanded}
        <div class="px-3 pb-3">
          <select
            value={selectedEnvironmentId ?? ''}
            on:change={(event) => setSelectedEnvironmentId(selectValue(event) || null)}
            class="select-field mt-3 h-8 w-full rounded px-2 text-sm outline-none"
            disabled={!selectedWorkspace || environments.length === 0}
          >
            {#each environments as environment (environment.id)}
              <option value={environment.id}>
                {environment.name}
              </option>
            {/each}
          </select>

          <form class="mt-2 flex gap-2" on:submit={handleCreateEnvironment}>
            <input
              value={environmentName}
              on:input={(event) => setEnvironmentName(inputValue(event))}
              placeholder="New environment"
              class="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
              disabled={!selectedWorkspace}
            />
            <button class="secondary-button h-8" disabled={!environmentName.trim() || !selectedWorkspace}>
              Add
            </button>
          </form>

          <form class="mt-3 space-y-2" on:submit={handleSaveVariable}>
            <div class="grid grid-cols-2 gap-2">
              <input
                value={variableKey}
                on:input={(event) => setVariableKey(inputValue(event))}
                placeholder="key"
                class="h-8 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-xs text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
                disabled={!selectedEnvironmentId}
              />
              <input
                value={variableValue}
                on:input={(event) => setVariableValue(inputValue(event))}
                placeholder="value"
                class="h-8 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-xs text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
                disabled={!selectedEnvironmentId}
              />
            </div>
            <button class="secondary-button h-8 w-full" disabled={!selectedEnvironmentId || !variableKey.trim()}>
              Save Variable
            </button>
          </form>

          <div class="mt-3 max-h-40 space-y-1 overflow-auto">
            {#if environmentVariables.length === 0}
              <p class="text-xs font-normal normal-case text-[var(--muted)]">
                Add `thub_url` to resolve {'{{thub_url}}'}.
              </p>
            {:else}
              {#each environmentVariables as variable (variable.id)}
                <div class="group flex items-center gap-2 rounded bg-[var(--panel)] px-2 py-1 text-xs">
                  <button
                    class="min-w-0 flex-1 text-left"
                    on:click={() => handleEditVariable(variable)}
                    type="button"
                    title="Edit variable"
                  >
                    <span class="font-mono text-[var(--text)]">{`{{${variable.key}}}`}</span>
                    <span class="ml-2 font-normal text-[var(--muted)]">{variable.value}</span>
                  </button>
                  <button
                    type="button"
                    class="text-[var(--muted)] opacity-0 group-hover:opacity-100"
                    on:click={() => handleDeleteVariable(variable)}
                  >
                    Delete
                  </button>
                </div>
              {/each}
            {/if}
          </div>
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
