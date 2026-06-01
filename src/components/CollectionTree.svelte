<script lang="ts">
  import FolderNode from './FolderNode.svelte'
  import { methodClass, ROOT_ID } from '../lib/collectionTree'
  import type { ApiFolder, ApiRequest, Collection } from '../tauri'

  export let collections: Collection[]
  export let foldersByParent: Map<string, ApiFolder[]>
  export let handleDeleteCollection: (collection: Collection) => Promise<void>
  export let handleRenameCollection: (collection: Collection) => Promise<void>
  export let loadingRequests: boolean
  export let openFolderIds: Set<string>
  export let requestsByFolder: Map<string, ApiRequest[]>
  export let selectedCollectionId: string | null
  export let selectedRequestId: string | null
  export let setSelectedCollectionId: (id: string | null) => void
  export let setSelectedRequestId: (id: string | null) => void
  export let toggleFolder: (folderId: string) => void

  $: rootFolders = foldersByParent.get(ROOT_ID) ?? []
  $: rootRequests = requestsByFolder.get(ROOT_ID) ?? []
</script>

{#each collections as collection (collection.id)}
  {@const expanded = collection.id === selectedCollectionId}
  <div class="mb-1">
    <div class={`group flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${expanded ? 'bg-[var(--surface)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--panel)]'}`}>
      <button class="flex min-w-0 flex-1 items-center gap-2 text-left" on:click={() => setSelectedCollectionId(collection.id)}>
        <span class="w-3 shrink-0 text-[var(--muted)]">{expanded ? 'v' : '>'}</span>
        <span class="min-w-0 flex-1 truncate">{collection.name}</span>
      </button>
      <button class="rounded px-1 text-[11px] text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] group-hover:opacity-100" on:click={() => handleRenameCollection(collection)}>Rename</button>
      <button class="rounded px-1 text-[11px] text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] group-hover:opacity-100" on:click={() => handleDeleteCollection(collection)}>Delete</button>
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
              {setSelectedRequestId}
              {toggleFolder}
            />
          {/each}
          {#each rootRequests as request (request.id)}
            <button
              on:click={() => setSelectedRequestId(request.id)}
              class={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${
                request.id === selectedRequestId
                  ? 'bg-[var(--surface)] text-[var(--text)]'
                  : 'text-[var(--muted)] hover:bg-[var(--panel)]'
              }`}
              style="padding-left: 8px"
            >
              <span class={`w-12 shrink-0 font-semibold ${methodClass(request.method)}`}>
                {request.method}
              </span>
              <span class="min-w-0 flex-1 truncate">{request.name}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/each}
