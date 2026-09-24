<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { Environment } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { errorInfo } from '../../lib/ipc'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import { createEnv, deleteEnv, duplicateEnv, renameEnv } from './envActions'
  import { EnvModel } from './envModel.svelte'
  import EnvironmentBulk from './EnvironmentBulk.svelte'
  import EnvironmentList from './EnvironmentList.svelte'
  import EnvironmentTable from './EnvironmentTable.svelte'
  import NameDialog from './NameDialog.svelte'
  import SaveStatus from './SaveStatus.svelte'

  const model = new EnvModel()
  let closing = $state(false)
  let closeError = $state<string | null>(null)
  let dialog = $state<null | { kind: 'create' } | { kind: 'rename'; env: Environment } | { kind: 'delete'; env: Environment }>(null)

  const selected = $derived(app.environments.find((e) => e.id === model.environmentId) ?? null)

  onMount(() => {
    const wanted = ui.envEditor.newVariable ? app.activeEnvironmentId : (ui.envEditor.environmentId ?? app.activeEnvironmentId)
    const id = app.environments.find((e) => e.id === wanted)?.id ?? app.environments[0]?.id
    if (id) void model.load(id)
  })
  onDestroy(() => model.dispose())

  // "Create variable" popover: add a row for the name, on the active environment.
  $effect(() => {
    const name = ui.envEditor.newVariable
    if (!name || !model.environmentId || model.loading) return
    ui.envEditor = { ...ui.envEditor, newVariable: undefined }
    void (async () => {
      const target = app.activeEnvironmentId
      if (target && target !== model.environmentId && !(await model.select(target))) return
      model.addNamed(name)
    })()
  })

  async function select(id: string) {
    closeError = null
    if (!(await model.select(id))) closeError = 'Some changes could not be saved. Fix or retry them before switching environments.'
  }

  async function requestClose() {
    closing = true
    closeError = null
    try {
      const r = await model.flush()
      if (r.ok) ui.envEditor = { open: false }
      else closeError = 'Some changes could not be saved. Fix or retry them, or discard them to close.'
    } finally {
      closing = false
    }
  }

  function discardAndClose() {
    model.discard()
    ui.envEditor = { open: false }
  }

  async function setActive(id: string) {
    try {
      await app.setActiveEnvironment(id)
    } catch (e) {
      toast.error('Could not set active environment', errorInfo(e).message)
    }
  }

  async function duplicate(env: Environment) {
    try {
      if (!(await model.flush()).ok) return void (closeError = 'Save or fix pending changes before duplicating.')
      const r = await duplicateEnv(env)
      const note = r.skippedSecrets > 0 ? ` ${r.skippedSecrets} secret variable${r.skippedSecrets === 1 ? ' was' : 's were'} NOT copied - re-enter them in the copy.` : ''
      toast.success(`Created "${r.env.name}"`, `${r.copied} variable${r.copied === 1 ? '' : 's'} copied.${note}`)
      await model.select(r.env.id)
    } catch (e) {
      toast.error('Duplicate failed', errorInfo(e).message)
    }
  }
</script>

<Dialog title="Environments" size="xl" onclose={requestClose} busy={closing}>
  {#if app.environments.length === 0}
    <div class="flex flex-col items-center gap-3 py-12 text-sm text-muted">
      <p>There are no environments yet.</p>
      {#if sync.blocked}<ReadOnlyNote />{:else}<Button variant="primary" onclick={() => (dialog = { kind: 'create' })}>Create environment</Button>{/if}
    </div>
  {:else}
    <div class="flex min-h-[22rem] gap-4">
      <EnvironmentList
        environments={app.environments}
        selectedId={model.environmentId}
        activeId={app.activeEnvironmentId}
        readOnly={sync.blocked}
        onselect={select}
        onsetactive={setActive}
        oncreate={() => (dialog = { kind: 'create' })}
        onrename={(env) => (dialog = { kind: 'rename', env })}
        onduplicate={duplicate}
        ondelete={(env) => (dialog = { kind: 'delete', env })}
      />
      <section class="flex min-w-0 flex-1 flex-col gap-2" aria-label="Variables">
        <div class="flex items-center justify-between gap-2">
          <h3 class="truncate text-sm font-semibold">{selected?.name ?? ''}</h3>
          <div class="flex items-center gap-2">
            <Button size="sm" disabled={model.loading || sync.blocked} onclick={() => (model.bulkMode ? (model.applyBulk(), model.exitBulk()) : model.enterBulk())}>
              {model.bulkMode ? 'Table edit' : 'Bulk edit'}
            </Button>
            <SaveStatus kind={model.status.kind} label={model.status.label} onretry={() => model.flush()} />
          </div>
        </div>
        <ReadOnlyNote />
        <InlineError message={closeError} />
        {#if closeError}
          <div><Button size="sm" variant="danger" onclick={discardAndClose}>Discard unsaved changes and close</Button></div>
        {/if}
        {#if model.duplicateNames.length > 0}
          <p role="status" data-testid="duplicate-banner" class="rounded border border-warning bg-warning-soft px-2 py-1.5 text-xs text-warning">
            Duplicate variable names: {model.duplicateNames.join(', ')}. Rows with duplicate names are not saved until every name is unique.
          </p>
        {/if}
        {#if model.loading}
          <div class="flex justify-center py-10"><Spinner /></div>
        {:else if model.loadError}
          <InlineError message={model.loadError} />
        {:else if model.bulkMode}
          <EnvironmentBulk {model} />
        {:else if selected}
          <EnvironmentTable {model} environmentName={selected.name} />
        {/if}
      </section>
    </div>
  {/if}
  {#snippet footer()}
    <Button onclick={requestClose} loading={closing}>Close</Button>
  {/snippet}
</Dialog>

{#if dialog?.kind === 'create'}
  <NameDialog
    title="New environment"
    confirmLabel="Create"
    oncancel={() => (dialog = null)}
    onsubmit={async (name) => {
      if (!(await model.flush()).ok) throw new Error('Save or fix pending changes first.')
      const env = await createEnv(name)
      await model.select(env.id)
    }}
  />
{:else if dialog?.kind === 'rename'}
  {@const env = dialog.env}
  <NameDialog title="Rename environment" confirmLabel="Rename" initial={env.name} oncancel={() => (dialog = null)} onsubmit={(name) => renameEnv(env.id, name)} />
{:else if dialog?.kind === 'delete'}
  {@const env = dialog.env}
  <ConfirmDialog
    title="Delete environment"
    message={`Delete "${env.name}" and all of its variables? This cannot be undone.`}
    confirmLabel="Delete"
    danger
    oncancel={() => (dialog = null)}
    onconfirm={async () => {
      if (env.id === model.environmentId) model.discard()
      await deleteEnv(env.id)
      const next = app.environments[0]
      if (next) await model.load(next.id)
    }}
  />
{/if}
