<script lang="ts">
  /** Sidebar > Workflows: the workspace's workflows (local to this device). Click opens one in a tab. */
  import type { WorkflowSummary } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import NameDialog from '../../components/ui/NameDialog.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { tabsStore } from '../requests/tabs.svelte'
  import { createWorkflow, deleteWorkflow, duplicateWorkflow, renameWorkflow } from './actions'
  import { workflowRuns } from './workflowRuns.svelte'

  let filter = $state('')
  let naming = $state<{ mode: 'new' } | { mode: 'rename'; workflow: WorkflowSummary } | null>(null)
  let confirmDelete = $state<WorkflowSummary | null>(null)
  let menu = $state<{ x: number; y: number; workflow: WorkflowSummary } | null>(null)

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase()
    return q ? app.workflows.filter((w) => w.name.toLowerCase().includes(q)) : app.workflows
  })
  const activeId = $derived(tabsStore.active?.workflowId ?? null)

  function menuItems(w: WorkflowSummary): MenuItem[] {
    return [
      { label: 'Open', icon: 'external', action: () => tabsStore.openWorkflow(w.id) },
      { label: 'Rename…', icon: 'edit', action: () => (naming = { mode: 'rename', workflow: w }) },
      { label: 'Duplicate', icon: 'copy', action: () => void duplicateWorkflow(w.id) },
      { separator: true, label: '' },
      { label: 'Delete…', icon: 'trash', danger: true, action: () => (confirmDelete = w) },
    ]
  }
  function openMenu(e: MouseEvent, w: WorkflowSummary) {
    e.preventDefault()
    menu = { x: e.clientX, y: e.clientY, workflow: w }
  }
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Workflows">
  <div class="flex items-center gap-1 border-b border-border p-2">
    <div class="relative min-w-0 flex-1">
      <span class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"><Icon name="search" size={13} /></span>
      <input
        type="search"
        bind:value={filter}
        aria-label="Filter workflows"
        placeholder="Filter workflows"
        class="h-7 w-full rounded border border-border bg-raised pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-focus"
      />
    </div>
    <IconButton icon="plus" label="New workflow" onclick={() => (naming = { mode: 'new' })} />
    <InfoTip label="About workflows">
      A workflow chains saved requests visually: connect nodes on a canvas so a response feeds the next request, a script or a
      branch, and run it all with one click. Workflows are kept on this device (they are not synced to Slinger Cloud).
    </InfoTip>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#if !app.workflowsLoaded}
      <div class="flex items-center justify-center gap-2 p-6 text-xs text-muted"><Spinner /> Loading workflows</div>
    {:else if app.workflows.length === 0}
      <div class="flex flex-col items-center gap-3 p-6 text-center text-xs text-muted">
        <p>No workflows yet.</p>
        <Button size="sm" variant="primary" icon="plus" onclick={() => (naming = { mode: 'new' })}>New workflow</Button>
      </div>
    {:else if shown.length === 0}
      <p class="p-4 text-center text-xs text-muted">No workflow matches "{filter}".</p>
    {:else}
      <ul aria-label="Workflow list">
        {#each shown as w (w.id)}
          {@const running = workflowRuns.forWorkflow(w.id)?.running}
          <li class="group relative">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-1.5 pr-9 text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-focus {activeId === w.id ? 'bg-accent-soft' : ''}"
              onclick={() => tabsStore.openWorkflow(w.id)}
              oncontextmenu={(e) => openMenu(e, w)}
              data-workflow-id={w.id}
            >
              <Icon name="workflow" size={14} class="shrink-0 text-muted" />
              <span class="min-w-0 flex-1 truncate">{w.name}</span>
              {#if running}<span class="shrink-0" title="Running"><Spinner /></span>{/if}
            </button>
            <IconButton
              icon="dots"
              label="Workflow actions: {w.name}"
              class="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 focus:opacity-100 group-hover:opacity-100"
              onclick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                menu = { x: r.left, y: r.bottom, workflow: w }
              }}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.workflow)} onclose={() => (menu = null)} />
{/if}

{#if naming}
  {@const n = naming}
  <NameDialog
    title={n.mode === 'new' ? 'New workflow' : 'Rename workflow'}
    label="Workflow name"
    initial={n.mode === 'rename' ? n.workflow.name : ''}
    submitLabel={n.mode === 'new' ? 'Create' : 'Rename'}
    placeholder="e.g. Sign in and fetch orders"
    onsubmit={async (name) => {
      if (n.mode === 'new') await createWorkflow(name)
      else await renameWorkflow(n.workflow.id, name)
      naming = null
    }}
    oncancel={() => (naming = null)}
  />
{/if}

{#if confirmDelete}
  {@const w = confirmDelete}
  <ConfirmDialog
    title="Delete workflow"
    message={`Delete “${w.name}”?${workflowRuns.forWorkflow(w.id)?.running ? ' Its run in progress stops.' : ''} Requests it uses are not affected.`}
    confirmLabel="Delete"
    danger
    onconfirm={async () => {
      await deleteWorkflow(w.id)
      confirmDelete = null
    }}
    oncancel={() => (confirmDelete = null)}
  />
{/if}
