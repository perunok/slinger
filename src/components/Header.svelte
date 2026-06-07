<script lang="ts">
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'

  export let selectedRequest: { name?: string } | null
  export let rightSidebarOpen = false
  export let toggleRightSidebar: () => void
  export let toolsIndicatorCount = 0

  const windowControlsAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  let appWindow: ReturnType<typeof getCurrentWindow> | null = null
  let maximized = false

  function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
    if (!windowControlsAvailable) return null

    appWindow ??= getCurrentWindow()
    return appWindow
  }

  async function updateMaximizedState(): Promise<void> {
    const window = currentWindow()
    if (!window) return

    maximized = await window.isMaximized()
  }

  async function minimizeWindow(): Promise<void> {
    await currentWindow()?.minimize()
  }

  async function toggleMaximizeWindow(): Promise<void> {
    const window = currentWindow()
    if (!window) return

    await window.toggleMaximize()
    await updateMaximizedState()
  }

  async function closeWindow(): Promise<void> {
    await currentWindow()?.close()
  }

  onMount(() => {
    const window = currentWindow()
    if (!window) return

    let mounted = true
    const unlisteners: Array<() => void> = []
    const trackUnlisten = (unlisten: () => void) => {
      if (mounted) {
        unlisteners.push(unlisten)
      } else {
        unlisten()
      }
    }

    void updateMaximizedState()
    void window.onResized(() => {
      void updateMaximizedState()
    }).then(trackUnlisten)
    void window.onFocusChanged(() => {
      void updateMaximizedState()
    }).then(trackUnlisten)

    return () => {
      mounted = false
      for (const unlisten of unlisteners) unlisten()
    }
  })
</script>

<header data-tauri-drag-region class="flex h-7 select-none items-center border-b border-[var(--border)] bg-[var(--toolbar)] pl-0 pr-3 text-[13px]">
  <div class="flex w-1/3 min-w-0 items-center gap-3 font-medium text-[var(--text)]">
    <div class="flex h-7 flex-shrink-0 items-center" aria-label="Window controls">
      <button
        type="button"
        class="inline-flex h-7 w-9 items-center justify-center text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)] focus:outline-none focus-visible:bg-[var(--surface)]"
        aria-label="Minimize window"
        title="Minimize"
        on:click|stopPropagation={minimizeWindow}
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M3 7h8" />
        </svg>
      </button>
      <button
        type="button"
        class="inline-flex h-7 w-9 items-center justify-center text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)] focus:outline-none focus-visible:bg-[var(--surface)]"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        on:click|stopPropagation={toggleMaximizeWindow}
      >
        {#if maximized}
          <svg class="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 3.5h5.5v5.5" />
            <path d="M3.5 5h5.5v5.5H3.5z" />
          </svg>
        {:else}
          <svg class="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" aria-hidden="true">
            <path d="M3.5 3.5h7v7h-7z" />
          </svg>
        {/if}
      </button>
      <button
        type="button"
        class="inline-flex h-7 w-9 items-center justify-center text-[var(--muted)] transition-colors hover:bg-[#e81123] hover:text-white focus:outline-none focus-visible:bg-[#e81123] focus-visible:text-white"
        aria-label="Close window"
        title="Close"
        on:click|stopPropagation={closeWindow}
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M4 4l6 6" />
          <path d="M10 4l-6 6" />
        </svg>
      </button>
    </div>
    <nav class="flex min-w-0 items-center gap-4" aria-label="Application menu">
      <span>File</span>
      <span>Edit</span>
      <span>View</span>
      <span>Help</span>
    </nav>
  </div>
  <div data-tauri-drag-region class="w-1/3 truncate text-center text-[var(--text)]">
    {selectedRequest ? `${selectedRequest.name} - Slinger` : 'Slinger'}
  </div>
  <div class="flex w-1/3 items-center justify-end gap-3 text-[var(--muted)]">
    <span>Invite</span>
    <button
      type="button"
      class={`inline-flex h-6 items-center gap-1.5 rounded px-2 transition-colors ${
        rightSidebarOpen
          ? 'bg-[var(--surface)] text-[var(--text)]'
          : 'text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
      }`}
      aria-pressed={rightSidebarOpen}
      aria-label={rightSidebarOpen ? 'Hide tools sidebar' : 'Show tools sidebar'}
      title={rightSidebarOpen ? 'Hide tools sidebar' : 'Show tools sidebar'}
      on:click={toggleRightSidebar}
    >
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </svg>
      <span>Tools</span>
      {#if toolsIndicatorCount > 0}
        <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-[#d7c35a] px-1 text-[10px] font-semibold leading-4 text-[#1b1b1b]">
          {toolsIndicatorCount}
        </span>
      {/if}
    </button>
  </div>
</header>
