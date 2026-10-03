<script lang="ts">
  import { ui } from '../app/ui.svelte'
  import EnvSwitcher from '../features/environments/EnvSwitcher.svelte'
  import WorkspaceSwitcher from '../features/workspaces/WorkspaceSwitcher.svelte'
  import IconButton from '../components/ui/IconButton.svelte'
  import SyncChip from '../features/sync/SyncChip.svelte'
  import RightPanelButton from '../features/layout/RightPanelButton.svelte'
  import { reportTitleBarOverlay } from '../lib/titleBarOverlay'
  import { windowChrome } from './windowChrome.svelte'

  let header = $state<HTMLElement | null>(null)

  // The system window buttons over a custom title bar follow its height (and settings.apply() reports colours).
  $effect(() => {
    if (!header || !windowChrome.custom || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => reportTitleBarOverlay())
    observer.observe(header)
    return () => observer.disconnect()
  })
</script>

<!-- With the custom title bar (default) this bar is the window's title bar: drag it to move the window. -->
<header
  bind:this={header}
  data-titlebar
  data-custom-titlebar={windowChrome.custom || undefined}
  class="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface {windowChrome.custom ? 'app-titlebar' : 'px-3'}"
>
  {#if windowChrome.menuButton}
    <IconButton icon="menu" label="Application menu" class="-mr-1" onclick={(e) => windowChrome.showMenu(e.currentTarget)} />
  {/if}
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
    <RightPanelButton />
    <IconButton icon="info" label="Keyboard shortcuts" onclick={() => (ui.shortcutsOpen = true)} />
    <IconButton icon="sun" label="Settings" onclick={() => (ui.settingsOpen = true)} />
    <IconButton icon="help" label="About Slinger" onclick={() => (ui.aboutOpen = true)} />
  </div>
</header>
