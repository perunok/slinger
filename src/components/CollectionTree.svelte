<script lang="ts">
  import FolderNode from './FolderNode.svelte'
  import RequestTreeItem from './RequestTreeItem.svelte'
  import { ROOT_ID } from '../lib/collectionTree'
  import type { ApiFolder, ApiRequest, Collection } from '../tauri'

  export let collections: Collection[]
  export let foldersByParent: Map<string, ApiFolder[]>
  export let handleDeleteCollection: (collection: Collection) => Promise<void>
  export let handleExportCollection: (collection: Collection) => Promise<void>
  export let handleRenameCollection: (collection: Collection) => Promise<void>
  export let loadingRequests: boolean
  export let openFolderIds: Set<string>
  export let requestsByFolder: Map<string, ApiRequest[]>
  export let selectedCollectionId: string | null
  export let selectedRequestId: string | null
  export let selectedResponseRequestId: string | null
  export let selectedResponseIndex: number
  export let setSelectedCollectionId: (id: string | null) => void
  export let setSelectedRequestId: (id: string | null) => void
  export let selectResponseExample: (requestId: string, responseIndex: number) => void
  export let toggleFolder: (folderId: string) => void

  $: rootFolders = foldersByParent.get(ROOT_ID) ?? []
  $: rootRequests = requestsByFolder.get(ROOT_ID) ?? []
</script>

{#each collections as collection (collection.id)}
  {@const expanded = collection.id === selectedCollectionId}
  <div class="mb-1">
    <div class={`collection-row group flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${expanded ? 'bg-[var(--surface)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--panel)]'}`}>
      <button
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        on:click={() => setSelectedCollectionId(expanded ? null : collection.id)}
      >
        <span class="w-3 shrink-0 text-[var(--muted)]">{expanded ? 'v' : '>'}</span>
        <span class="min-w-0 flex-1 truncate">{collection.name}</span>
      </button>
      <div class="collection-actions">
        <button
          type="button"
          class="collection-actions-trigger"
          title="Collection actions"
          aria-label="Collection actions"
        >
          ...
        </button>
        <div class="collection-actions-menu">
          <button type="button" title="Export Postman collection" on:click={() => handleExportCollection(collection)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v11" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
            <span>Export</span>
          </button>
          <button type="button" title="Rename collection" on:click={() => handleRenameCollection(collection)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" />
              <path d="m13.5 7.5 3.5 3.5" />
            </svg>
            <span>Rename</span>
          </button>
          <button type="button" title="Delete collection" class="danger" on:click={() => handleDeleteCollection(collection)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14" />
              <path d="M9 7V5h6v2" />
              <path d="m8 7 .8 14h6.4L16 7" />
              <path d="M10.5 11v5" />
              <path d="M13.5 11v5" />
            </svg>
            <span>Delete</span>
          </button>
        </div>
      </div>
    </div>

    {#if expanded}
      <div class="ml-3 mt-1 space-y-1">
        {#if loadingRequests}
          <p class="py-2 text-xs text-[var(--muted)]">Loading requests...</p>
        {:else if rootFolders.length === 0 && rootRequests.length === 0}
          <p class="py-2 text-xs text-[var(--muted)]">No requests yet.</p>
        {:else}
          {#each rootFolders as folder (folder.id)}
            <FolderNode
              {folder}
              depth={0}
              {foldersByParent}
              {requestsByFolder}
              {openFolderIds}
              {selectedRequestId}
              {selectedResponseRequestId}
              {selectedResponseIndex}
              {setSelectedRequestId}
              {selectResponseExample}
              {toggleFolder}
            />
          {/each}
          {#each rootRequests as request (request.id)}
            <RequestTreeItem
              {request}
              depth={0}
              {selectedRequestId}
              {selectedResponseRequestId}
              {selectedResponseIndex}
              {setSelectedRequestId}
              {selectResponseExample}
            />
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/each}

<style>
  .collection-row {
    position: relative;
  }

  .collection-actions {
    position: relative;
    flex: 0 0 auto;
  }

  .collection-actions-trigger {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.25rem;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1;
    opacity: 0;
  }

  .collection-row:hover .collection-actions-trigger,
  .collection-actions:focus-within .collection-actions-trigger {
    opacity: 1;
  }

  .collection-actions-trigger:hover,
  .collection-actions-trigger:focus-visible {
    background: var(--panel);
    color: var(--text);
    outline: none;
  }

  .collection-actions-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 50;
    display: none;
    min-width: 9.5rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-alt);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.32);
    padding: 0.25rem;
  }

  .collection-actions:hover .collection-actions-menu,
  .collection-actions:focus-within .collection-actions-menu {
    display: grid;
  }

  .collection-actions-menu button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.25rem;
    color: var(--muted);
    padding: 0.45rem 0.55rem;
    font-size: 0.8125rem;
    text-align: left;
  }

  .collection-actions-menu button:hover,
  .collection-actions-menu button:focus-visible {
    background: var(--surface);
    color: var(--text);
    outline: none;
  }

  .collection-actions-menu button.danger:hover,
  .collection-actions-menu button.danger:focus-visible {
    color: #f87171;
  }

  .collection-actions-menu svg {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 0.875rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
