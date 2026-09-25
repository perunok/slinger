<script lang="ts">
  import { onMount } from 'svelte'
  import SplitPane from '../components/ui/SplitPane.svelte'
  import ToastHost from '../components/ui/ToastHost.svelte'
  import Spinner from '../components/ui/Spinner.svelte'
  import Button from '../components/ui/Button.svelte'
  import CloudDialog from '../features/cloud/CloudDialog.svelte'
  import SyncBanner from '../features/sync/SyncBanner.svelte'
  import SyncHost from '../features/sync/SyncHost.svelte'
  import EnvironmentEditor from '../features/environments/EnvironmentEditor.svelte'
  import EnvironmentExportDialog from '../features/environments/EnvironmentExportDialog.svelte'
  import ExampleView from '../features/examples/ExampleView.svelte'
  import OverviewView from '../features/overview/OverviewView.svelte'
  import ExportCollectionDialog from '../features/importexport/ExportCollectionDialog.svelte'
  import ImportPostmanDialog from '../features/importexport/ImportPostmanDialog.svelte'
  import QuickOpen from '../features/requests/QuickOpen.svelte'
  import RequestTabs from '../features/requests/RequestTabs.svelte'
  import RequestView from '../features/requests/RequestView.svelte'
  import SaveAsDialog from '../features/requests/SaveAsDialog.svelte'
  import { tabsStore } from '../features/requests/tabs.svelte'
  import UnsavedDialog from '../features/requests/UnsavedDialog.svelte'
  import RunnerDialog from '../features/runner/RunnerDialog.svelte'
  import ScriptsDialogHost from '../features/scripts/ScriptsDialogHost.svelte'
  import SettingsDialog from '../features/settings/SettingsDialog.svelte'
  import ShortcutsDialog from '../features/settings/ShortcutsDialog.svelte'
  import VersionsDialog from '../features/versions/VersionsDialog.svelte'
  import WorkspacesDialog from '../features/workspaces/WorkspacesDialog.svelte'
  import EmptyState from './EmptyState.svelte'
  import { scopeStore } from './scope.svelte'
  import { settings } from './settings.svelte'
  import { handleShortcut } from './shortcuts'
  import Sidebar from './Sidebar.svelte'
  import { app } from './state.svelte'
  import TopBar from './TopBar.svelte'
  import { ui } from './ui.svelte'

  onMount(() => {
    settings.init()
    scopeStore.createVariable = (name) => (ui.envEditor = { open: true, newVariable: name })
    void app.init()
    return () => {
      scopeStore.createVariable = null
    }
  })
</script>

<svelte:window onkeydown={handleShortcut} />

<div class="flex h-full flex-col">
  <TopBar />
  <SyncBanner />
  {#if !app.ready}
    <div class="flex flex-1 items-center justify-center gap-2 text-muted"><Spinner /> Loading…</div>
  {:else if app.fatalError}
    <div class="m-auto max-w-md rounded border border-danger bg-danger-soft p-4 text-sm" role="alert">
      <p class="font-semibold text-danger">Slinger could not start</p>
      <p class="mt-1">{app.fatalError}</p>
      <Button class="mt-3" onclick={() => void app.init()}>Retry</Button>
    </div>
  {:else}
    <SplitPane direction="row" storageKey="slinger.split.sidebar" initial={0.24} min={0.14} class="min-h-0">
      {#snippet first()}<Sidebar />{/snippet}
      {#snippet second()}
        <main class="flex h-full min-h-0 flex-col bg-surface">
          {#if tabsStore.tabs.length === 0}
            <EmptyState />
          {:else}
            <RequestTabs />
            {#if tabsStore.active}
              {#key tabsStore.active.id}
                {#if tabsStore.active.overview}
                  <OverviewView tab={tabsStore.active} />
                {:else if tabsStore.active.example}
                  <ExampleView tab={tabsStore.active} />
                {:else}
                  <RequestView tab={tabsStore.active} />
                {/if}
              {/key}
            {/if}
          {/if}
        </main>
      {/snippet}
    </SplitPane>
  {/if}
</div>

{#if ui.settingsOpen}<SettingsDialog />{/if}
{#if ui.workspacesOpen}<WorkspacesDialog />{/if}
{#if ui.shortcutsOpen}<ShortcutsDialog />{/if}
{#if ui.quickOpen}<QuickOpen />{/if}
<CloudDialog />
<SyncHost />
<EnvironmentEditor />
<VersionsDialog />
<RunnerDialog />
<ScriptsDialogHost />
<ExportCollectionDialog />
<EnvironmentExportDialog />
<ImportPostmanDialog open={ui.importOpen} onclose={() => (ui.importOpen = false)} />
<SaveAsDialog />
<UnsavedDialog />
<ToastHost />
