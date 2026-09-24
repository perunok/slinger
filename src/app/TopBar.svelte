<script lang="ts">
  import { ui } from '../app/ui.svelte'
  import EnvSwitcher from '../features/environments/EnvSwitcher.svelte'
  import WorkspaceSwitcher from '../features/workspaces/WorkspaceSwitcher.svelte'
  import IconButton from '../components/ui/IconButton.svelte'
  import SyncChip from '../features/sync/SyncChip.svelte'
</script>

<header class="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
  <span class="text-sm font-bold tracking-wide text-accent">Slinger</span>
  <WorkspaceSwitcher />
  <SyncChip />
  {#if window.__slingerMock}
    <span class="rounded bg-warning-soft px-2 py-0.5 text-xs text-warning" title="Running in a browser with an in-memory mock backend; data is not persisted.">Mock backend</span>
  {/if}
  <div class="ml-auto flex items-center gap-1">
    <button
      type="button"
      class="mr-2 flex h-7 items-center gap-2 rounded border border-border bg-raised px-2 text-xs text-muted hover:bg-hover"
      onclick={() => (ui.quickOpen = true)}
    >
      Go to request… <kbd class="rounded border border-border px-1 font-mono">Ctrl K</kbd>
    </button>
    <EnvSwitcher />
    <IconButton icon="cloud" label="Cloud" onclick={() => (ui.cloudOpen = true)} />
    <IconButton icon="info" label="Keyboard shortcuts" onclick={() => (ui.shortcutsOpen = true)} />
    <IconButton icon="sun" label="Settings" onclick={() => (ui.settingsOpen = true)} />
  </div>
</header>
