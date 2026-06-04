<script lang="ts">
  import RequestTreeItem from './RequestTreeItem.svelte'
  import type { ApiFolder, ApiRequest } from '../tauri'

  export let folder: ApiFolder
  export let depth = 0
  export let foldersByParent: Map<string, ApiFolder[]>
  export let requestsByFolder: Map<string, ApiRequest[]>
  export let openFolderIds: Set<string>
  export let selectedRequestId: string | null
  export let selectedResponseRequestId: string | null
  export let selectedResponseIndex: number
  export let setSelectedRequestId: (id: string | null) => void
  export let selectResponseExample: (requestId: string, responseIndex: number) => void
  export let toggleFolder: (folderId: string) => void
  export let handleRenameRequest: (request: ApiRequest) => Promise<void>
  export let handleDeleteRequest: (request: ApiRequest) => Promise<void>

  $: isOpen = openFolderIds.has(folder.id)
  $: childFolders = foldersByParent.get(folder.id) ?? []
  $: childRequests = requestsByFolder.get(folder.id) ?? []
</script>

<div>
  <button
    class="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-[#d8d8d8] hover:bg-[#303030]"
    on:click={() => toggleFolder(folder.id)}
    style={`padding-left: ${8 + depth * 14}px`}
  >
    <span class="w-3 shrink-0 text-[var(--muted)]">{isOpen ? 'v' : '>'}</span>
    <span class="min-w-0 flex-1 truncate">{folder.name}</span>
  </button>

  {#if isOpen}
    <div class="space-y-1">
      {#each childFolders as child (child.id)}
        <svelte:self
          folder={child}
          depth={depth + 1}
          {foldersByParent}
          {requestsByFolder}
          {openFolderIds}
          {selectedRequestId}
          {selectedResponseRequestId}
          {selectedResponseIndex}
          {setSelectedRequestId}
          {selectResponseExample}
          {toggleFolder}
          {handleRenameRequest}
          {handleDeleteRequest}
        />
      {/each}
      {#each childRequests as request (request.id)}
        <RequestTreeItem
          {request}
          depth={depth + 1}
          {selectedRequestId}
          {selectedResponseRequestId}
          {selectedResponseIndex}
          {setSelectedRequestId}
          {selectResponseExample}
          {handleRenameRequest}
          {handleDeleteRequest}
        />
      {/each}
    </div>
  {/if}
</div>
