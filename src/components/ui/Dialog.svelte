<script lang="ts">
  import { onMount, type Snippet } from 'svelte'
  import IconButton from './IconButton.svelte'
  import { isTopDialog, popDialog, pushDialog } from './dialogStack'

  interface Props {
    title: string
    onclose: () => void
    size?: 'sm' | 'md' | 'lg' | 'xl'
    /** While busy (e.g. saving) the dialog cannot be dismissed. */
    busy?: boolean
    children: Snippet
    footer?: Snippet
  }
  let { title, onclose, size = 'md', busy = false, children, footer }: Props = $props()

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-6xl' }
  const uid = Math.random().toString(36).slice(2, 8)
  let root: HTMLDivElement
  const id = pushDialog()
  let previouslyFocused: Element | null = null

  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

  function focusables(): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && !el.closest('[inert],[hidden]'))
  }

  function close() {
    if (!busy) onclose()
  }

  function onkeydown(e: KeyboardEvent) {
    if (!isTopDialog(id)) return
    if (e.key === 'Escape') {
      // Let open popups (autocomplete, menus) consume Escape first.
      if (e.defaultPrevented) return
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'Tab') {
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  onMount(() => {
    previouslyFocused = document.activeElement
    const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables().find((el) => !el.closest('[data-dialog-close]')) ?? root
    target.focus()
    document.addEventListener('keydown', onkeydown)
    return () => {
      document.removeEventListener('keydown', onkeydown)
      popDialog(id)
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) previouslyFocused.focus()
    }
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onmousedown={(e) => e.target === e.currentTarget && close()}>
  <div
    bind:this={root}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-title-{uid}"
    tabindex="-1"
    class="flex max-h-[90vh] w-full flex-col rounded-lg border border-strong bg-surface shadow-pop outline-none {widths[size]}"
  >
    <header class="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
      <h2 id="dlg-title-{uid}" class="truncate text-sm font-semibold">{title}</h2>
      <span data-dialog-close><IconButton icon="x" label="Close dialog" onclick={close} disabled={busy} /></span>
    </header>
    <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
      {@render children()}
    </div>
    {#if footer}
      <footer class="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        {@render footer()}
      </footer>
    {/if}
  </div>
</div>
