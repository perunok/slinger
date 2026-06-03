<script lang="ts">
  export let selectedRequest: { name?: string } | null
  export let rightSidebarOpen = false
  export let toggleRightSidebar: () => void
</script>

<header class="flex h-7 items-center border-b border-[var(--border)] bg-[var(--toolbar)] px-3 text-[13px]">
  <div class="flex w-1/3 items-center gap-4 font-medium text-[var(--text)]">
    <span>File</span>
    <span>Edit</span>
    <span>View</span>
    <span>Help</span>
  </div>
  <div class="w-1/3 truncate text-center text-[var(--text)]">
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
    </button>
  </div>
</header>
