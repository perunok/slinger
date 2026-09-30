<script lang="ts">
  import { onMount } from 'svelte'
  import SplitPane from '../components/ui/SplitPane.svelte'
  import ToastHost from '../components/ui/ToastHost.svelte'
  import Spinner from '../components/ui/Spinner.svelte'
  import Button from '../components/ui/Button.svelte'
  import AboutDialog from '../features/about/AboutDialog.svelte'
  import CloudDialog from '../features/cloud/CloudDialog.svelte'
  import SyncBanner from '../features/sync/SyncBanner.svelte'
  import SyncHost from '../features/sync/SyncHost.svelte'
  import EnvironmentEditor from '../features/environments/EnvironmentEditor.svelte'
  import EnvironmentExportDialog from '../features/environments/EnvironmentExportDialog.svelte'
  import ExampleView from '../features/examples/ExampleView.svelte'
  import OverviewView from '../features/overview/OverviewView.svelte'
  import { openCollectionVariables } from '../features/overview/openVariables'
  import { saveVariableValue } from '../features/environments/editVariable'
  import { sync } from '../features/sync/syncStore.svelte'
  import ExportCollectionDialog from '../features/importexport/ExportCollectionDialog.svelte'
  import ImportDialog from '../features/importexport/ImportDialog.svelte'
  import QuickOpen from '../features/requests/QuickOpen.svelte'
  import RequestTabs from '../features/requests/RequestTabs.svelte'
  import RequestView from '../features/requests/RequestView.svelte'
  import SaveAsDialog from '../features/requests/SaveAsDialog.svelte'
  import { tabsStore } from '../features/requests/tabs.svelte'
  import { cancelScheduledSave, flushSave, scheduleSave, serializeTabs } from '../features/requests/tabsPersistence'
  import UnsavedDialog from '../features/requests/UnsavedDialog.svelte'
  import RunnerDialog from '../features/runner/RunnerDialog.svelte'
  import ScriptsDialogHost from '../features/scripts/ScriptsDialogHost.svelte'
  import SettingsDialog from '../features/settings/SettingsDialog.svelte'
  import ShortcutsDialog from '../features/settings/ShortcutsDialog.svelte'
  import VersionsDialog from '../features/versions/VersionsDialog.svelte'
  import WorkspacesDialog from '../features/workspaces/WorkspacesDialog.svelte'
  import EmptyState from './EmptyState.svelte'
  import StatusBar from '../features/layout/StatusBar.svelte'
  import RightPanel from '../features/layout/RightPanel.svelte'
  import { fitPanelWidth, minMainWidth, rightPanel } from '../features/layout/rightPanelStore.svelte'
  import { scopeStore } from './scope.svelte'
  import { settings } from './settings.svelte'
  import { subscribeMenuCommands } from './menuCommands'
  import { handleShortcut } from './shortcuts'
  import Sidebar from './Sidebar.svelte'
  import { app } from './state.svelte'
  import { dismissBootSkeleton } from './bootSkeleton'
  import TopBar from './TopBar.svelte'
  import { ui } from './ui.svelte'

  onMount(() => {
    settings.init()
    scopeStore.createVariable = (name, target = 'environment') => {
      const collectionId = scopeStore.scope.collectionId
      if (target === 'globals') ui.envEditor = { open: true, globals: true, newVariable: name }
      else if (target === 'collection' && collectionId) openCollectionVariables(collectionId, name)
      else ui.envEditor = { open: true, newVariable: name }
    }
    scopeStore.editVariable = saveVariableValue
    scopeStore.editBlocked = () => (sync.blocked ? sync.blockedMessage : null)
    void app.init()
    const offMenu = subscribeMenuCommands()
    return () => {
      scopeStore.createVariable = null
      scopeStore.editVariable = null
      scopeStore.editBlocked = null
      offMenu()
    }
  })

  // `{{}}` in the active tab resolve against its collection's variables too.
  $effect(() => {
    scopeStore.collectionId = tabsStore.active?.collectionId ?? null
  })

  // The right panel only shows when the main area keeps a usable width next to it (see rightPanel.svelte.ts).
  let areaWidth = $state(0)
  const fittedPanelWidth = $derived(fitPanelWidth(areaWidth, rightPanel.width, minMainWidth(settings.responsePosition)))
  $effect(() => {
    rightPanel.room = fittedPanelWidth !== null
  })

  // The launch skeleton (index.html) covers the UI until the first workspace has loaded, or startup failed.
  $effect(() => {
    if (app.ready) dismissBootSkeleton(app.fatalError ? 'error' : 'ready')
  })

  /**
   * Debounced autosave of open tabs, per workspace (see tabsPersistence.ts). Reading `tabsStore.tabs`
   * and each tab's fields (inside serializeTabs) is what makes this effect re-run on every relevant
   * change, including keystrokes in a draft; only the localStorage write itself is delayed.
   */
  $effect(() => {
    const workspaceId = app.workspaceId
    if (!workspaceId) return
    if (!settings.restoreTabsOnStartup) {
      cancelScheduledSave(workspaceId)
      return
    }
    scheduleSave(workspaceId, serializeTabs(tabsStore.tabs, tabsStore.activeId))
  })
</script>

<svelte:window onkeydown={handleShortcut} onbeforeunload={() => flushSave()} onpagehide={() => flushSave()} />

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
        <div class="flex h-full min-h-0 min-w-0" bind:clientWidth={areaWidth}>
        <main class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface">
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
        {#if rightPanel.open && fittedPanelWidth !== null}<RightPanel width={fittedPanelWidth} />{/if}
        </div>
      {/snippet}
    </SplitPane>
    {#if settings.showStatusBar}
      <StatusBar />
    {/if}
  {/if}
</div>

{#if ui.settingsOpen}<SettingsDialog />{/if}
{#if ui.workspacesOpen}<WorkspacesDialog />{/if}
{#if ui.shortcutsOpen}<ShortcutsDialog />{/if}
{#if ui.quickOpen}<QuickOpen />{/if}
{#if ui.aboutOpen}<AboutDialog />{/if}
<CloudDialog />
<SyncHost />
<EnvironmentEditor />
<VersionsDialog />
<RunnerDialog />
<ScriptsDialogHost />
<ExportCollectionDialog />
<EnvironmentExportDialog />
<ImportDialog open={ui.importOpen} initialText={ui.importText} onclose={() => ui.closeImport()} />
<SaveAsDialog />
<UnsavedDialog />
<ToastHost />
