<script lang="ts">
  import Icon from '../../components/ui/Icon.svelte'
  import { statusTone } from '../../lib/response'
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
  // Requests open on click; their chevron alone expands/collapses the saved examples below them.
  const opensOnClick = $derived(row.kind === 'request' || row.kind === 'example')
  const codeClass = $derived(
    row.code == null ? 'text-faint' : { success: 'text-success', info: 'text-muted', warning: 'text-warning', danger: 'text-danger' }[statusTone(row.code)],
  )
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
  draggable={row.kind === 'folder' || row.kind === 'request'}
  title={hint?.blocked}
  class="group flex h-7 cursor-pointer select-none items-center gap-1 pr-2 text-sm outline-offset-[-2px] {active ? 'bg-accent-soft' : 'hover:bg-hover'} {dragging ? 'opacity-40' : ''}"
  style="padding-left:{row.depth * 14 + 6}px; {hintStyle}"
  onclick={() => (opensOnClick || !row.expandable ? onactivate() : ontoggle())}
  onfocus={onfocusrow}
  {oncontextmenu}
  {ondragstart}
  {ondragover}
  {ondrop}
  {ondragend}
  {ondragleave}
>
  {#if row.expandable && opensOnClick}
    <!-- Mouse affordance only; keyboard users expand with ArrowRight/ArrowLeft on the row. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <span
      aria-hidden="true"
      data-testid="examples-toggle"
      class="-my-1 -ml-1 flex h-7 w-5 shrink-0 items-center justify-center rounded hover:bg-hover"
      title={row.expanded ? 'Hide examples' : 'Show examples'}
      onclick={(e) => {
        e.stopPropagation()
        ontoggle()
      }}
    >
      <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} class="text-faint" />
    </span>
  {:else if row.expandable}
    <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} class="shrink-0 text-faint" />
  {:else}
    <span class="w-3 shrink-0"></span>
  {/if}
  {#if row.kind === 'request'}
    <span class="w-9 shrink-0 text-[10px] font-bold" style="color:{methodColor(row.method ?? '')}">{(row.method ?? '').slice(0, 5)}</span>
  {:else if row.kind === 'example'}
    <span class="w-9 shrink-0 text-[10px] font-bold {codeClass}" title="Saved example">{row.code ?? 'e.g.'}</span>
  {:else}
    <Icon name={row.kind === 'collection' ? 'layers' : 'folder'} size={14} class="shrink-0 text-muted" />
  {/if}
  <span class="min-w-0 flex-1 truncate {row.kind === 'collection' ? 'font-medium' : ''}">{row.label}</span>
  {#if row.count !== undefined}
    {#if row.kind === 'request'}
      <!-- Hidden from the accessible name (it would change every request's label); aria-expanded tells it has children. -->
      <span aria-hidden="true" class="shrink-0 rounded-full bg-raised px-1.5 text-[10px] leading-4 text-faint" title="{row.count} saved example{row.count === 1 ? '' : 's'}">{row.count}</span>
    {:else}
      <span class="shrink-0 text-xs text-faint">{row.count}</span>
    {/if}
  {/if}
</div>
