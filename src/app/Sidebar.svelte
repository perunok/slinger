<script lang="ts">
  import Tabs from '../components/ui/Tabs.svelte'
  import CollectionsPanel from '../features/collections/CollectionsPanel.svelte'
  import HistoryPanel from '../features/history/HistoryPanel.svelte'
  import { ui } from './ui.svelte'
</script>

<nav class="flex h-full min-h-0 flex-col bg-surface" aria-label="Sidebar">
  <Tabs
    label="Sidebar views"
    idPrefix="side"
    value={ui.sidebar}
    onchange={(v) => (ui.sidebar = v as 'collections' | 'history')}
    tabs={[
      { id: 'collections', label: 'Collections' },
      { id: 'history', label: 'History' },
    ]}
  />
  <div class="min-h-0 flex-1" role="tabpanel" id="side-panel-{ui.sidebar}" aria-labelledby="side-{ui.sidebar}">
    {#if ui.sidebar === 'collections'}<CollectionsPanel />{:else}<HistoryPanel />{/if}
  </div>
</nav>
