<script lang="ts">
  import Button from '../components/ui/Button.svelte'
  import { tabsStore } from '../features/requests/tabs.svelte'
  import { sync } from '../features/sync/syncStore.svelte'
  import { ui } from './ui.svelte'
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 text-center">
  <h1 class="text-lg font-semibold">Welcome to Slinger</h1>
  <p class="max-w-sm text-sm text-muted">Open a request from a collection, or start a new one. Variables like <code>{'{{baseUrl}}'}</code> resolve from the active environment.</p>
  <div class="flex gap-2">
    <Button variant="primary" icon="plus" onclick={() => tabsStore.newTab()}>New request</Button>
    <Button icon="upload" disabled={sync.blocked} title={sync.blocked ? sync.blockedMessage : 'Import a Slinger or Postman collection or environment'} onclick={() => ui.openImport()}>Import…</Button>
  </div>
  <p class="text-xs text-faint">Press <kbd class="rounded border border-border bg-raised px-1">Ctrl+/</kbd> for keyboard shortcuts</p>
</div>
