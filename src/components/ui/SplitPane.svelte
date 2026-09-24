<script lang="ts">
  /** Two panes with a draggable, keyboard-adjustable divider. `direction="column"` stacks them vertically. */
  import type { Snippet } from 'svelte'

  interface Props {
    direction?: 'row' | 'column'
    storageKey: string
    initial?: number
    min?: number
    first: Snippet
    second: Snippet
    class?: string
  }
  let { direction = 'column', storageKey, initial = 0.5, min = 0.15, first, second, class: cls = '' }: Props = $props()

  function load(): number {
    try {
      const v = Number(localStorage.getItem(storageKey))
      if (v >= 0.05 && v <= 0.95) return v
    } catch {
      /* ignore */
    }
    return initial
  }
  let ratio = $state(load())
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
    ratio = clamp(direction === 'column' ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width)
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
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    role="separator"
    aria-orientation={direction === 'column' ? 'horizontal' : 'vertical'}
    aria-valuenow={Math.round(ratio * 100)}
    aria-label="Resize panes"
    tabindex="0"
    class="shrink-0 bg-border transition-colors hover:bg-accent focus-visible:bg-accent {dragging ? 'bg-accent' : ''} {direction === 'column' ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize'}"
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    {onkeydown}
  ></div>
  <div class="min-h-0 min-w-0 overflow-hidden" style="flex: {1 - ratio} 1 0%">{@render second()}</div>
</div>
