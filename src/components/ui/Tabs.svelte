<script lang="ts">
  /** Accessible tab list (roving tabindex, arrow keys). Panels are rendered by the parent. */
  export interface TabDef {
    id: string
    label: string
    /** Small indicator after the label (e.g. count or dot). */
    badge?: string
    /** Badge colour (default: accent). */
    badgeTone?: 'accent' | 'success' | 'danger'
  }
  interface Props {
    tabs: TabDef[]
    value: string
    onchange: (id: string) => void
    label: string
    idPrefix?: string
    /** Vertical lists sit beside their panel and use Up/Down keys. */
    orientation?: 'horizontal' | 'vertical'
    class?: string
  }
  let { tabs, value, onchange, label, idPrefix = 'tab', orientation = 'horizontal', class: cls = '' }: Props = $props()
  const vertical = $derived(orientation === 'vertical')

  function onkeydown(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (i + 1) % tabs.length
    else if (e.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    onchange(tabs[next].id)
    queueMicrotask(() => document.getElementById(`${idPrefix}-${tabs[next].id}`)?.focus())
  }
</script>

<div
  role="tablist"
  aria-label={label}
  aria-orientation={orientation}
  class="flex gap-0.5 {vertical ? 'flex-col border-r border-border' : 'items-center border-b border-border'} {cls}"
  {onkeydown}
  tabindex="-1"
>
  {#each tabs as t (t.id)}
    <button
      type="button"
      role="tab"
      id="{idPrefix}-{t.id}"
      aria-selected={t.id === value}
      aria-controls="{idPrefix}-panel-{t.id}"
      tabindex={t.id === value ? 0 : -1}
      class="relative flex items-center gap-1 px-3 py-1.5 text-sm transition-colors {vertical
        ? `-mr-px justify-between border-r-2 text-left ${t.id === value ? 'border-accent bg-accent-soft text-fg' : 'border-transparent text-muted hover:bg-surface-hover hover:text-fg'}`
        : `-mb-px border-b-2 ${t.id === value ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}"
      onclick={() => onchange(t.id)}
    >
      {t.label}
      {#if t.badge}<span
          class="rounded-full px-1.5 text-[10px] leading-4 {t.badgeTone === 'success' ? 'bg-success-soft text-success' : t.badgeTone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-fg'}"
          data-testid="{idPrefix}-{t.id}-badge">{t.badge}</span>{/if}
    </button>
  {/each}
</div>
