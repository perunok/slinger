<script lang="ts">
  /**
   * A small (i) button whose explanation shows on hover or keyboard focus (Escape hides it). The panel is positioned
   * against the window, so a scrolling dialog body cannot clip it; it opens above the button, or below when there is no
   * room.
   */
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  interface Props {
    /** Accessible name of the button, e.g. "About running collections". */
    label: string
    children: Snippet
  }
  let { label, children }: Props = $props()

  const WIDTH = 320
  const id = `infotip-${Math.random().toString(36).slice(2, 10)}`
  let button = $state<HTMLButtonElement | null>(null)
  let open = $state(false)
  let pos = $state<{ left: number; top: number; above: boolean }>({ left: 0, top: 0, above: true })

  function show() {
    if (!button) return
    const r = button.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - WIDTH - 8))
    const above = r.top > 180
    pos = { left, top: above ? r.top - 6 : r.bottom + 6, above }
    open = true
  }
  const hide = () => (open = false)
</script>

<span class="inline-flex" role="presentation" onmouseenter={show} onmouseleave={hide}>
  <button
    bind:this={button}
    type="button"
    class="inline-flex rounded-full p-0.5 text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    aria-label={label}
    aria-describedby={open ? id : undefined}
    onfocus={show}
    onblur={hide}
    onkeydown={(e) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation()
        hide()
      }
    }}
  >
    <Icon name="info" size={14} />
  </button>
  {#if open}
    <span
      {id}
      role="tooltip"
      class="pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded border border-border bg-surface p-2.5 text-xs leading-snug text-fg shadow-lg"
      style="left: {pos.left}px; top: {pos.top}px; width: {WIDTH}px; {pos.above ? 'transform: translateY(-100%);' : ''}"
    >
      {@render children()}
    </span>
  {/if}
</span>
