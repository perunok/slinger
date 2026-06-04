<script lang="ts">
  import type { Workspace } from '../tauri'

  export let workspaces: Workspace[]
  export let selectedWorkspaceId: string | null
  export let setSelectedWorkspaceId: (id: string | null) => void
  export let loadingWorkspaces: boolean
  export let workspaceName: string
  export let setWorkspaceName: (value: string) => void
  export let handleCreateWorkspace: (event: SubmitEvent) => Promise<void>
  export let theme: 'dark' | 'light'
  export let setTheme: (theme: 'dark' | 'light') => void
  export let orientation: 'vertical' | 'horizontal'
  export let setOrientation: (orientation: 'vertical' | 'horizontal') => void
  export let openCloudPanel: () => void

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }
</script>

<div class="flex h-16 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-alt)] px-3">
  <div class="flex items-center gap-2 text-[#a8a8a8]">
    <button class="toolbar-button" aria-label="Back">
      &lt;
    </button>
    <button class="toolbar-button" aria-label="Forward">
      &gt;
    </button>
  </div>

  <select
    value={selectedWorkspaceId ?? ''}
    on:change={(event) => setSelectedWorkspaceId(selectValue(event) || null)}
    class="select-field h-8 w-52 rounded px-2 text-sm outline-none"
    disabled={loadingWorkspaces}
  >
    {#each workspaces as workspace (workspace.id)}
      <option value={workspace.id}>
        {workspace.name}
      </option>
    {/each}
  </select>

  <form class="flex items-center gap-2" on:submit={handleCreateWorkspace}>
    <input
      value={workspaceName}
      on:input={(event) => setWorkspaceName(inputValue(event))}
      placeholder="New workspace"
      class="h-8 w-40 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
    />
    <button class="secondary-button" disabled={!workspaceName.trim()}>
      Add
    </button>
  </form>

  <div class="mx-auto flex h-8 w-[320px] items-center rounded border border-[var(--border)] bg-[var(--panel)] px-3 text-sm text-[var(--muted)]">
    Search
  </div>

  <button
    class="secondary-button"
    type="button"
    aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    on:click={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
  >
    {#if theme === 'dark'}
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"></circle>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    {/if}
  </button>
  <button
    class="secondary-button"
    type="button"
    aria-label={orientation === 'vertical' ? 'Switch to side-by-side' : 'Switch to stacked'}
    on:click={() => setOrientation(orientation === 'vertical' ? 'horizontal' : 'vertical')}
    title={orientation === 'vertical' ? 'Side-by-side' : 'Stacked'}
  >
    <span class="text-[var(--muted)]">{orientation === 'vertical' ? '⇆' : '⇕'}</span>
  </button>
  <button class="secondary-button">Save</button>
  <button class="secondary-button" type="button" on:click={openCloudPanel}>Cloud</button>
</div>
