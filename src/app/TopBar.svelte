<script lang="ts">
  import type { Snippet } from 'svelte'
  import { settings } from '../app/settings.svelte'
  import { ui } from '../app/ui.svelte'
  import EnvSwitcher from '../features/environments/EnvSwitcher.svelte'
  import WorkspaceSwitcher from '../features/workspaces/WorkspaceSwitcher.svelte'
  import ContextMenu from '../components/ui/ContextMenu.svelte'
  import IconButton from '../components/ui/IconButton.svelte'
  import SyncChip from '../features/sync/SyncChip.svelte'
  import RightPanelButton from '../features/layout/RightPanelButton.svelte'
  import SidebarButton from '../features/layout/SidebarButton.svelte'
  import type { TitleBarItem } from '../lib/titleBarLayout'
  import { reportTitleBarOverlay } from '../lib/titleBarOverlay'
  import { windowChrome } from './windowChrome.svelte'

  let header = $state<HTMLElement | null>(null)
  let menu = $state<{ x: number; y: number } | null>(null)

  // The system window buttons over a custom title bar follow its height (and settings.apply() reports colours).
  $effect(() => {
    if (!header || !windowChrome.custom || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => reportTitleBarOverlay())
    observer.observe(header)
    return () => observer.disconnect()
  })

  /** Right-click on an empty part of the bar: the way to its layout settings. */
  function onContextMenu(e: MouseEvent) {
    if ((e.target as Element).closest('button, a, input, select, [role="button"], [role="combobox"]')) return
    e.preventDefault()
    menu = { x: e.clientX, y: e.clientY }
  }
  function customize() {
    ui.settingsFocus = 'titlebar'
    ui.settingsOpen = true
  }
</script>

{#snippet item(id: TitleBarItem)}
  {#if id === 'menu'}
    {#if windowChrome.menuButton}<IconButton icon="menu" label="Application menu" onclick={(e) => windowChrome.showMenu(e.currentTarget)} />{/if}
  {:else if id === 'sidebar'}
    <SidebarButton />
  {:else if id === 'workspace'}
    <WorkspaceSwitcher />
  {:else if id === 'sync'}
    <SyncChip />
  {:else if id === 'search'}
    <button
      type="button"
      class="flex h-7 items-center gap-2 rounded border border-border bg-raised px-2 text-xs text-muted hover:bg-hover"
      onclick={() => (ui.quickOpen = true)}
    >
      Go to request… <kbd class="rounded border border-border px-1 font-mono">Ctrl K</kbd>
    </button>
  {:else if id === 'environment'}
    <EnvSwitcher />
  {:else if id === 'rightPanel'}
    <RightPanelButton />
  {:else if id === 'shortcuts'}
    <IconButton icon="info" label="Keyboard shortcuts" onclick={() => (ui.shortcutsOpen = true)} />
  {:else if id === 'settings'}
    <IconButton icon="sun" label="Settings" onclick={() => (ui.settingsOpen = true)} />
  {:else if id === 'about'}
    <IconButton icon="help" label="About Slinger" onclick={() => (ui.aboutOpen = true)} />
  {/if}
{/snippet}

{#snippet side(items: TitleBarItem[], cls: string, extra?: Snippet)}
  <div class="flex items-center gap-1.5 whitespace-nowrap {cls}" data-titlebar-side>
    {#each items as id (id)}{@render item(id)}{/each}
    {@render extra?.()}
  </div>
{/snippet}

{#snippet mockBadge()}
  {#if window.__slingerMock}
    <span class="rounded bg-warning-soft px-2 py-0.5 text-xs text-warning" title="Running in a browser with an in-memory mock backend; data is not persisted.">Mock backend</span>
  {/if}
{/snippet}

<!-- With the custom title bar (default) this bar is the window's title bar: drag it to move the window. Which items sit
     on which side, in which order, is a setting (Settings > Window, or right-click the bar). -->
<!-- svelte-ignore a11y_no_static_element_interactions (the right-click menu is a mouse shortcut to Settings > Window) -->
<header
  bind:this={header}
  data-titlebar
  data-custom-titlebar={windowChrome.custom || undefined}
  class="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface {windowChrome.custom ? 'app-titlebar' : 'px-3'}"
  oncontextmenu={onContextMenu}
>
  {@render side(settings.titleBarLayout.left, 'min-w-0', mockBadge)}
  {@render side(settings.titleBarLayout.right, 'ml-auto shrink-0')}
</header>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={[{ label: 'Customize title bar…', icon: 'settings', action: customize }]} onclose={() => (menu = null)} />
{/if}
