<script lang="ts">
  /**
   * Two panes with a draggable, keyboard-adjustable divider. `direction="column"` stacks them vertically.
   * The ratio is persisted per `storageKey` and re-read when the key changes (e.g. one key per orientation).
   * `action` renders a small control on the divider (right end of a horizontal divider, bottom end of a vertical
   * one); it is a sibling of the separator, so pressing it never starts a drag.
   */
  import type { Snippet } from 'svelte'

  interface Props {
    direction?: 'row' | 'column'
    storageKey: string
    initial?: number
    min?: number
    first: Snippet
    second: Snippet
    action?: Snippet
    class?: string
  }
  let { direction = 'column', storageKey, initial = 0.5, min = 0.15, first, second, action, class: cls = '' }: Props = $props()

  function load(storageKey: string, initial: number): number {
    try {
      const v = Number(localStorage.getItem(storageKey))
      if (v >= 0.05 && v <= 0.95) return v
    } catch {
      /* ignore */
    }
    return initial
  }
  // Writable derived: dragging overrides it, a new storageKey (or initial) reloads it.
  let ratio = $derived(load(storageKey, initial))
  let root: HTMLDivElement
  let dragging = $state(false)

  function clamp(v: number) {
    return Math.min(1 - min, Math.max(min, v))
  }
  function save() {
    try {
      localStorage.setItem(storageKey, String(ratio))
    } catch {
      /* ignore */
    }
  }
  function onpointerdown(e: PointerEvent) {
    dragging = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onpointermove(e: PointerEvent) {
    if (!dragging) return
    const r = root.getBoundingClientRect()
    const next = direction === 'column' ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width
    if (Number.isFinite(next)) ratio = clamp(next)
  }
  function onpointerup() {
    if (dragging) save()
    dragging = false
  }
  function onkeydown(e: KeyboardEvent) {
    const [dec, inc] = direction === 'column' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
    if (e.key === dec) ratio = clamp(ratio - 0.03)
    else if (e.key === inc) ratio = clamp(ratio + 0.03)
    else return
    e.preventDefault()
    save()
  }
</script>

<div bind:this={root} class="flex min-h-0 min-w-0 flex-1 {direction === 'column' ? 'flex-col' : 'flex-row'} {cls}">
  <div class="min-h-0 min-w-0 overflow-hidden" style="flex: {ratio} 1 0%">{@render first()}</div>
  <div class="relative flex shrink-0 {direction === 'column' ? 'h-1' : 'w-1'}">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      role="separator"
      aria-orientation={direction === 'column' ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-label="Resize panes"
      tabindex="0"
      class="flex-1 bg-border transition-colors hover:bg-accent focus-visible:bg-accent {dragging ? 'bg-accent' : ''} {direction === 'column' ? 'cursor-row-resize' : 'cursor-col-resize'}"
      {onpointerdown}
      {onpointermove}
      {onpointerup}
      {onkeydown}
    ></div>
    {#if action}
      <div class="absolute z-10 {direction === 'column' ? 'right-3 top-1/2 -translate-y-1/2' : 'bottom-3 left-1/2 -translate-x-1/2'}" data-testid="split-action">
        {@render action()}
      </div>
    {/if}
  </div>
  <div class="min-h-0 min-w-0 overflow-hidden" style="flex: {1 - ratio} 1 0%">{@render second()}</div>
</div>
