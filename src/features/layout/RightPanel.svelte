<script lang="ts">
  /**
   * The right side panel: a resize handle, a tab list of the registered views (panels.ts) and the active view for the
   * active request/example tab. The app shell decides whether it fits and passes the width to show it at.
   */
  import IconButton from '../../components/ui/IconButton.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { tabsStore } from '../requests/tabs.svelte'
  import { RIGHT_PANEL_SHORTCUT } from './layoutActions'
  import { availablePanels, resolvePanel } from './panels'
  import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, rightPanel } from './rightPanelStore.svelte'

  /** Width to render at (already fitted to the room next to the main area). */
  let { width }: { width: number } = $props()

  const panels = $derived(availablePanels())
  const current = $derived(resolvePanel(rightPanel.panel))
  const View = $derived(current.component)
  /** Overview tabs are not requests: the views show their empty state. */
  const tab = $derived(tabsStore.active && !tabsStore.active.overview && !tabsStore.active.workflowId ? tabsStore.active : null)

  let dragging = $state(false)
  let startX = 0
  let startWidth = 0
  let live = $state<number | null>(null)
  const shown = $derived(live ?? width)

  function onpointerdown(e: PointerEvent) {
    dragging = true
    startX = e.clientX
    startWidth = width
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  function onpointermove(e: PointerEvent) {
    if (!dragging || !Number.isFinite(e.clientX)) return
    live = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, startWidth + (startX - e.clientX)))
  }
  function onpointerup() {
    if (dragging && live !== null) rightPanel.setWidth(live)
    dragging = false
    live = null
  }
  function onkeydown(e: KeyboardEvent) {
    // The panel is on the right: Left makes it wider, Right narrower.
    const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0
    if (!step) return
    e.preventDefault()
    rightPanel.setWidth(width + step)
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize right panel"
  aria-valuenow={Math.round(shown)}
  aria-valuemin={PANEL_MIN_WIDTH}
  aria-valuemax={PANEL_MAX_WIDTH}
  tabindex="0"
  class="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent focus-visible:bg-accent {dragging ? 'bg-accent' : ''}"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  {onkeydown}
></div>
<aside aria-label="Right panel" class="flex h-full min-h-0 shrink-0 flex-col bg-surface" style="width: {shown}px" data-testid="right-panel">
  <div class="flex shrink-0 items-stretch">
    <Tabs
      tabs={panels.map((p) => ({ id: p.id, label: p.label }))}
      value={current.id}
      onchange={(id) => rightPanel.show(id)}
      label="Right panel views"
      idPrefix="rp"
      class="scroll-strip min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-1"
    />
    <div class="flex items-center border-b border-border pr-1">
      <IconButton icon="x" label="Close right panel ({RIGHT_PANEL_SHORTCUT})" size={13} onclick={() => rightPanel.setOpen(false)} />
    </div>
  </div>
  <div class="min-h-0 flex-1 overflow-auto" role="tabpanel" id="rp-panel-{current.id}" aria-labelledby="rp-{current.id}">
    <View {tab} />
  </div>
</aside>
