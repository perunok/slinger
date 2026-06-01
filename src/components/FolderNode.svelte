<script lang="ts">
  import { methodClass } from '../lib/collectionTree'
  import type { ApiFolder, ApiRequest } from '../tauri'

  export let folder: ApiFolder
  export let depth = 0
  export let foldersByParent: Map<string, ApiFolder[]>
  export let requestsByFolder: Map<string, ApiRequest[]>
  export let openFolderIds: Set<string>
  export let selectedRequestId: string | null
  export let setSelectedRequestId: (id: string | null) => void
  export let toggleFolder: (folderId: string) => void

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
          {setSelectedRequestId}
          {toggleFolder}
        />
      {/each}
      {#each childRequests as request (request.id)}
        <button
          on:click={() => setSelectedRequestId(request.id)}
          class={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${
            request.id === selectedRequestId
              ? 'bg-[var(--surface)] text-[var(--text)]'
              : 'text-[var(--muted)] hover:bg-[var(--panel)]'
          }`}
          style={`padding-left: ${8 + (depth + 1) * 14}px`}
        >
          <span class={`w-12 shrink-0 font-semibold ${methodClass(request.method)}`}>
            {request.method}
          </span>
          <span class="min-w-0 flex-1 truncate">{request.name}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
