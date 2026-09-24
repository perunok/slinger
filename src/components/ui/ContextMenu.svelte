<script lang="ts" module>
  export interface MenuItem {
    label: string
    icon?: string
    danger?: boolean
    disabled?: boolean
    separator?: boolean
    hint?: string
    action?: () => void
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'

  interface Props {
    x: number
    y: number
    items: MenuItem[]
    onclose: () => void
  }
  let { x, y, items, onclose }: Props = $props()
  let root: HTMLDivElement
  let index = $state(-1)
  let pos = $state({ left: 0, top: 0 })

  const actionable = () => items.map((it, i) => ({ it, i })).filter(({ it }) => !it.separator && !it.disabled).map(({ i }) => i)

  function move(dir: 1 | -1) {
    const list = actionable()
    if (!list.length) return
    const at = list.indexOf(index)
    index = list[(at + dir + list.length) % list.length] ?? list[0]
    root.querySelectorAll<HTMLElement>('[role=menuitem]')[index]?.focus()
  }

  function choose(it: MenuItem) {
    if (it.disabled || it.separator) return
    onclose()
    it.action?.()
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onclose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (index >= 0) choose(items[index])
    } else if (e.key === 'Tab') {
      e.preventDefault()
      onclose()
    }
  }

  onMount(() => {
    const r = root.getBoundingClientRect()
    pos = {
      left: Math.max(4, Math.min(x, window.innerWidth - (r.width || 200) - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - (r.height || 200) - 4)),
    }
    move(1)
    const down = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) onclose()
    }
    document.addEventListener('mousedown', down, true)
    window.addEventListener('blur', onclose)
    window.addEventListener('resize', onclose)
    return () => {
      document.removeEventListener('mousedown', down, true)
      window.removeEventListener('blur', onclose)
      window.removeEventListener('resize', onclose)
    }
  })
</script>

<div
  bind:this={root}
  role="menu"
  tabindex="-1"
  {onkeydown}
  class="fixed z-[60] min-w-44 rounded-md border border-strong bg-surface py-1 shadow-pop"
  style="left:{pos.left}px;top:{pos.top}px"
>
  {#each items as it, i (i)}
    {#if it.separator}
      <div role="separator" class="my-1 border-t border-border"></div>
    {:else}
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        disabled={it.disabled}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-40 {it.danger ? 'text-danger' : ''}"
        onclick={() => choose(it)}
        onmouseenter={() => (index = i)}
      >
        <span class="inline-flex w-4 justify-center">{#if it.icon}<Icon name={it.icon} size={14} />{/if}</span>
        <span class="flex-1">{it.label}</span>
        {#if it.hint}<span class="text-xs text-faint">{it.hint}</span>{/if}
      </button>
    {/if}
  {/each}
</div>
