<script lang="ts">
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import { methodColor } from './method'
  import { tabsStore } from './tabs.svelte'

  let menu = $state<{ x: number; y: number; id: string } | null>(null)

  function items(id: string): MenuItem[] {
    const t = tabsStore.find(id)
    return [
      { label: 'Close', icon: 'x', hint: 'Ctrl+W', action: () => tabsStore.requestClose([id]) },
      { label: 'Close others', disabled: tabsStore.tabs.length < 2, action: () => tabsStore.closeOthers(id) },
      { label: 'Close all', action: () => tabsStore.closeAll() },
      { separator: true, label: '' },
      { label: 'Save', icon: 'save', disabled: !t?.dirty || !t?.requestId, action: () => t && void tabsStore.save(t) },
    ]
  }

  function onkeydown(e: KeyboardEvent, id: string) {
    const i = tabsStore.tabs.findIndex((t) => t.id === id)
    let n = -1
    if (e.key === 'ArrowRight') n = (i + 1) % tabsStore.tabs.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabsStore.tabs.length) % tabsStore.tabs.length
    else if (e.key === 'Delete') return tabsStore.requestClose([id])
    if (n < 0) return
    e.preventDefault()
    tabsStore.activate(tabsStore.tabs[n].id)
    queueMicrotask(() => document.getElementById(`rtab-${tabsStore.tabs[n].id}`)?.focus())
  }
</script>

<div class="flex items-stretch border-b border-border bg-bg">
  <div role="tablist" aria-label="Open requests" class="flex min-w-0 flex-1 items-stretch overflow-x-auto">
    {#each tabsStore.tabs as t (t.id)}
      {@const active = t.id === tabsStore.activeId}
      <div
        class="group flex max-w-56 shrink-0 items-center border-r border-border {active ? 'bg-surface' : 'bg-bg hover:bg-hover'}"
        style={active ? 'box-shadow: inset 0 2px 0 var(--accent)' : ''}
        oncontextmenu={(e) => {
          e.preventDefault()
          menu = { x: e.clientX, y: e.clientY, id: t.id }
        }}
        role="presentation"
      >
        <button
          type="button"
          role="tab"
          id="rtab-{t.id}"
          aria-selected={active}
          aria-controls="request-panel"
          tabindex={active ? 0 : -1}
          class="flex min-w-0 items-center gap-1.5 py-1.5 pl-3 pr-1 text-sm {active ? 'text-fg' : 'text-muted'}"
          onclick={() => tabsStore.activate(t.id)}
          onkeydown={(e) => onkeydown(e, t.id)}
          onauxclick={(e) => e.button === 1 && tabsStore.requestClose([t.id])}
        >
          <span class="shrink-0 text-[10px] font-bold" style="color:{methodColor(t.draft.method)}">{t.draft.method.slice(0, 4)}</span>
          <span class="truncate">{t.title}</span>
          {#if t.dirty}<span class="h-2 w-2 shrink-0 rounded-full bg-warning" title="Unsaved changes" role="img" aria-label="Unsaved changes"></span>{/if}
        </button>
        <IconButton icon="x" label="Close {t.title}" size={12} class="!h-5 !w-5 mr-1 opacity-60 group-hover:opacity-100" tabindex={active ? 0 : -1} onclick={() => tabsStore.requestClose([t.id])} />
      </div>
    {/each}
  </div>
  <IconButton icon="plus" label="New request (Ctrl+T)" class="m-1" onclick={() => tabsStore.newTab()} />
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={items(menu.id)} onclose={() => (menu = null)} />
{/if}
