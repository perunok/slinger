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
  import Icon from '../components/ui/Icon.svelte'
  import { WINDOW_BUTTONS, type TitleBarItem } from '../lib/titleBarLayout'
  import { windowChrome } from './windowChrome.svelte'

  let menu = $state<{ x: number; y: number } | null>(null)

  const isButton = (id: TitleBarItem) => WINDOW_BUTTONS.includes(id)
  /** What a side shows: window buttons only where Slinger draws them (Windows/Linux, custom title bar). */
  const visible = (items: TitleBarItem[]) => items.filter((id) => !isButton(id) || windowChrome.ownWindowButtons)
  const left = $derived(visible(settings.titleBarLayout.left))
  const right = $derived(visible(settings.titleBarLayout.right))
  /** Runs of neighbouring window buttons stay together (no gap), like a system title bar. */
  function groups(items: TitleBarItem[]): Array<{ buttons: boolean; items: TitleBarItem[] }> {
    const out: Array<{ buttons: boolean; items: TitleBarItem[] }> = []
    for (const id of items) {
      const last = out.at(-1)
      if (last && last.buttons === isButton(id)) last.items.push(id)
      else out.push({ buttons: isButton(id), items: [id] })
    }
    return out
  }
  // A window button at the very edge sits in the window's corner (no padding), as in a system title bar.
  const flushLeft = $derived(left.length > 0 && isButton(left[0]!))
  const flushRight = $derived(right.length > 0 && isButton(right.at(-1)!))

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

{#snippet windowButton(id: TitleBarItem)}
  {@const maximized = windowChrome.state.maximized}
  {@const label = id === 'minimize' ? 'Minimise' : id === 'close' ? 'Close' : maximized ? 'Restore' : 'Maximise'}
  <button
    type="button"
    class="flex w-11 items-center justify-center self-stretch text-muted transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)] {id === 'close' ? 'hover:bg-danger hover:!text-danger-fg' : 'hover:bg-hover'}"
    aria-label={label}
    title={label}
    data-window-button={id}
    onclick={() => windowChrome.control(id === 'maximize' ? 'toggleMaximize' : (id as 'minimize' | 'close'))}
  >
    <Icon name={id === 'minimize' ? 'win-minimize' : id === 'close' ? 'x' : maximized ? 'win-restore' : 'win-maximize'} size={15} />
  </button>
{/snippet}

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
    <IconButton icon="gear" label="Settings" onclick={() => (ui.settingsOpen = true)} />
  {:else if id === 'about'}
    <IconButton icon="help" label="About Slinger" onclick={() => (ui.aboutOpen = true)} />
  {/if}
{/snippet}

{#snippet side(items: TitleBarItem[], cls: string, extra?: Snippet)}
  <div class="flex items-center gap-1.5 self-stretch whitespace-nowrap {cls}" data-titlebar-side>
    {#each groups(items) as group, i (i)}
      {#if group.buttons}
        <div class="flex self-stretch" role="group" aria-label="Window">
          {#each group.items as id (id)}{@render windowButton(id)}{/each}
        </div>
      {:else}
        {#each group.items as id (id)}{@render item(id)}{/each}
      {/if}
    {/each}
    {@render extra?.()}
  </div>
{/snippet}

{#snippet mockBadge()}
  {#if window.__slingerMock}
    <span class="rounded bg-warning-soft px-2 py-0.5 text-xs text-warning" title="Running in a browser with an in-memory mock backend; data is not persisted.">Mock backend</span>
  {/if}
{/snippet}

<!-- With the custom title bar (default) this bar is the window's title bar: drag it to move the window. Which items sit
     on which side, in which order, is a setting (Settings > Layout & window, or right-click the bar). -->
<!-- svelte-ignore a11y_no_static_element_interactions (the right-click menu is a mouse shortcut to Settings > Layout & window) -->
<header
  data-titlebar
  data-custom-titlebar={windowChrome.custom || undefined}
  class="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface {windowChrome.custom ? 'app-titlebar' : 'px-3'} {flushLeft ? '!pl-0' : ''} {flushRight ? '!pr-0' : ''}"
  oncontextmenu={onContextMenu}
>
  {@render side(left, 'min-w-0', mockBadge)}
  {@render side(right, 'ml-auto shrink-0')}
</header>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={[{ label: 'Customize title bar…', icon: 'settings', action: customize }]} onclose={() => (menu = null)} />
{/if}
