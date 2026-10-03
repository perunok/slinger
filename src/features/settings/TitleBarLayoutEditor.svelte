<script lang="ts">
  /**
   * Settings > Window: which items the title bar shows, on which side, in which order. Drag an item to another place,
   * or focus it and use the arrow keys (up/down: order; left/right: Left, Right, Hidden). Changes apply at once.
   */
  import { tick } from 'svelte'
  import { settings } from '../../app/settings.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import {
    ALWAYS_SHOWN,
    DEFAULT_TITLE_BAR_LAYOUT,
    TITLE_BAR_ITEM_LABELS,
    moveItem,
    nudgeItem,
    sameLayout,
    type TitleBarItem,
    type TitleBarSide,
  } from '../../lib/titleBarLayout'

  const SIDES: Array<{ id: TitleBarSide; label: string }> = [
    { id: 'left', label: 'Left' },
    { id: 'right', label: 'Right' },
    { id: 'hidden', label: 'Hidden' },
  ]
  const DRAG_TYPE = 'application/x-slinger-titlebar-item'
  const layout = $derived(settings.titleBarLayout)
  let root: HTMLElement | undefined = $state()
  let dragging = $state<TitleBarItem | null>(null)
  let dropAt = $state<{ side: TitleBarSide; index: number } | null>(null)

  async function refocus(item: TitleBarItem) {
    await tick()
    root?.querySelector<HTMLElement>(`[data-item="${item}"]`)?.focus()
  }

  function onKey(e: KeyboardEvent, item: TitleBarItem) {
    const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp']
    if (!dir) return
    e.preventDefault()
    settings.setTitleBarLayout(nudgeItem(layout, item, dir))
    void refocus(item)
  }

  /** Where in `side`'s list a drop at clientY lands (before the first item whose middle is below it). */
  function indexAt(list: HTMLElement, clientY: number): number {
    const items = [...list.querySelectorAll<HTMLElement>('[data-item]')].filter((el) => el.dataset.item !== dragging)
    const i = items.findIndex((el) => {
      const r = el.getBoundingClientRect()
      return clientY < r.top + r.height / 2
    })
    return i < 0 ? items.length : i
  }

  function onDragOver(e: DragEvent, side: TitleBarSide) {
    if (!dragging || !e.dataTransfer?.types.includes(DRAG_TYPE)) return
    if (side === 'hidden' && ALWAYS_SHOWN.includes(dragging)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    dropAt = { side, index: indexAt(e.currentTarget as HTMLElement, e.clientY) }
  }

  function onDrop(e: DragEvent, side: TitleBarSide) {
    const item = dragging
    if (!item || !dropAt) return
    e.preventDefault()
    settings.setTitleBarLayout(moveItem(layout, item, side, dropAt.index))
    dragging = null
    dropAt = null
  }
</script>

<div class="grid gap-1.5" bind:this={root} data-testid="titlebar-layout">
  <div class="flex items-center gap-1.5 text-sm">
    <span>Title bar items</span>
    <InfoTip label="About arranging the title bar">
      Choose which buttons the title bar (the bar at the top) shows and where: drag an item to the Left or Right list, or to
      Hidden. With the keyboard, focus an item and press the arrow keys: up and down change its place in the list, left and
      right move it between Left, Right and Hidden. Settings always stays visible. You can also right-click an empty part of
      the title bar and choose Customize title bar.
    </InfoTip>
    <Button size="sm" variant="ghost" icon="refresh" class="ml-auto" disabled={sameLayout(layout, DEFAULT_TITLE_BAR_LAYOUT)} onclick={() => settings.resetTitleBarLayout()}>
      Reset
    </Button>
  </div>
  <div class="grid grid-cols-3 gap-2">
    {#each SIDES as side (side.id)}
      <section aria-label="{side.label} side" class="flex min-w-0 flex-col rounded border border-border bg-surface">
        <h4 class="border-b border-border px-2 py-1 text-xs font-semibold text-muted">{side.label}</h4>
        <ul
          class="flex min-h-24 flex-col gap-1 p-1.5 {dropAt?.side === side.id ? 'bg-accent-soft' : ''}"
          aria-label="{side.label} items"
          data-side={side.id}
          ondragover={(e) => onDragOver(e, side.id)}
          ondragleave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dropAt = null
          }}
          ondrop={(e) => onDrop(e, side.id)}
        >
          {#each layout[side.id] as item, i (item)}
            {@const fi = layout[side.id].filter((x) => x !== dragging).indexOf(item)}
            {#if dropAt?.side === side.id && item !== dragging && dropAt.index === fi}<li class="h-0.5 rounded bg-accent" aria-hidden="true"></li>{/if}
            <li>
              <button
                type="button"
                draggable="true"
                data-item={item}
                class="flex w-full cursor-grab items-center gap-1.5 rounded border border-border bg-raised px-2 py-1 text-left text-xs hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus {dragging === item ? 'opacity-50' : ''}"
                aria-label="{TITLE_BAR_ITEM_LABELS[item]}, {side.label.toLowerCase()} {side.id === 'hidden' ? '' : `position ${i + 1}`}"
                ondragstart={(e) => {
                  dragging = item
                  e.dataTransfer?.setData(DRAG_TYPE, item)
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                }}
                ondragend={() => {
                  dragging = null
                  dropAt = null
                }}
                onkeydown={(e) => onKey(e, item)}
              >
                <Icon name="grip" size={12} class="shrink-0 text-faint" />
                <span class="min-w-0 truncate">{TITLE_BAR_ITEM_LABELS[item]}</span>
              </button>
            </li>
          {/each}
          {#if dropAt?.side === side.id && dropAt.index >= layout[side.id].filter((x) => x !== dragging).length}<li class="h-0.5 rounded bg-accent" aria-hidden="true"></li>{/if}
          {#if layout[side.id].length === 0}<li class="px-1 py-2 text-center text-[11px] text-faint">Drop items here</li>{/if}
        </ul>
      </section>
    {/each}
  </div>
</div>
