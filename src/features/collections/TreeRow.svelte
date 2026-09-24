<script lang="ts">
  import Icon from '../../components/ui/Icon.svelte'
  import { methodColor } from '../requests/method'
  import type { TreeRowModel } from './rows'

  export interface DropHint {
    key: string
    position: 'before' | 'after' | 'inside'
    blocked?: string
    noop?: boolean
  }

  interface Props {
    row: TreeRowModel
    active: boolean
    focused: boolean
    hint: DropHint | null
    dragging: boolean
    ontoggle: () => void
    onactivate: () => void
    onfocusrow: () => void
    oncontextmenu: (e: MouseEvent) => void
    ondragstart: (e: DragEvent) => void
    ondragover: (e: DragEvent) => void
    ondrop: (e: DragEvent) => void
    ondragend: () => void
    ondragleave: () => void
  }
  let { row, active, focused, hint, dragging, ontoggle, onactivate, onfocusrow, oncontextmenu, ondragstart, ondragover, ondrop, ondragend, ondragleave }: Props = $props()

  const hintStyle = $derived.by(() => {
    if (!hint || hint.noop) return ''
    if (hint.blocked) return 'box-shadow: inset 0 0 0 1px var(--danger); cursor: not-allowed'
    if (hint.position === 'before') return 'box-shadow: inset 0 2px 0 var(--accent)'
    if (hint.position === 'after') return 'box-shadow: inset 0 -2px 0 var(--accent)'
    return 'box-shadow: inset 0 0 0 2px var(--accent); background: var(--accent-soft)'
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  role="treeitem"
  data-key={row.key}
  aria-level={row.depth + 1}
  aria-posinset={row.posInSet}
  aria-setsize={row.setSize}
  aria-expanded={row.expandable ? row.expanded : undefined}
  aria-selected={active}
  tabindex={focused ? 0 : -1}
  draggable={row.kind !== 'collection'}
  title={hint?.blocked}
  class="group flex h-7 cursor-pointer select-none items-center gap-1 pr-2 text-sm outline-offset-[-2px] {active ? 'bg-accent-soft' : 'hover:bg-hover'} {dragging ? 'opacity-40' : ''}"
  style="padding-left:{row.depth * 14 + 6}px; {hintStyle}"
  onclick={() => (row.expandable ? ontoggle() : onactivate())}
  onfocus={onfocusrow}
  {oncontextmenu}
  {ondragstart}
  {ondragover}
  {ondrop}
  {ondragend}
  {ondragleave}
>
  {#if row.expandable}
    <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} class="shrink-0 text-faint" />
  {:else}
    <span class="w-3 shrink-0"></span>
  {/if}
  {#if row.kind === 'request'}
    <span class="w-9 shrink-0 text-[10px] font-bold" style="color:{methodColor(row.method ?? '')}">{(row.method ?? '').slice(0, 5)}</span>
  {:else}
    <Icon name={row.kind === 'collection' ? 'layers' : 'folder'} size={14} class="shrink-0 text-muted" />
  {/if}
  <span class="min-w-0 flex-1 truncate {row.kind === 'collection' ? 'font-medium' : ''}">{row.label}</span>
  {#if row.count !== undefined}<span class="shrink-0 text-xs text-faint">{row.count}</span>{/if}
</div>
