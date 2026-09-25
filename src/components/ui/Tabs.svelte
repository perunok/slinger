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
    class?: string
  }
  let { tabs, value, onchange, label, idPrefix = 'tab', class: cls = '' }: Props = $props()

  function onkeydown(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    onchange(tabs[next].id)
    queueMicrotask(() => document.getElementById(`${idPrefix}-${tabs[next].id}`)?.focus())
  }
</script>

<div role="tablist" aria-label={label} class="flex items-center gap-0.5 border-b border-border {cls}" {onkeydown} tabindex="-1">
  {#each tabs as t (t.id)}
    <button
      type="button"
      role="tab"
      id="{idPrefix}-{t.id}"
      aria-selected={t.id === value}
      aria-controls="{idPrefix}-panel-{t.id}"
      tabindex={t.id === value ? 0 : -1}
      class="relative -mb-px flex items-center gap-1 border-b-2 px-3 py-1.5 text-sm transition-colors {t.id === value ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}"
      onclick={() => onchange(t.id)}
    >
      {t.label}
      {#if t.badge}<span
          class="rounded-full px-1.5 text-[10px] leading-4 {t.badgeTone === 'success' ? 'bg-success-soft text-success' : t.badgeTone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-fg'}"
          data-testid="{idPrefix}-{t.id}-badge">{t.badge}</span>{/if}
    </button>
  {/each}
</div>
