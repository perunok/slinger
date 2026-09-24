<script lang="ts">
  import Tabs from '../../components/ui/Tabs.svelte'
  import SplitPane from '../../components/ui/SplitPane.svelte'
  import { dataRows } from '../../lib/kv'
  import { ui } from '../../app/ui.svelte'
  import ResponsePane from '../response/ResponsePane.svelte'
  import AuthPanel from './AuthPanel.svelte'
  import BodyPanel from './BodyPanel.svelte'
  import CodePanel from './CodePanel.svelte'
  import ConflictDialog from './ConflictDialog.svelte'
  import DocsPanel from './DocsPanel.svelte'
  import HeadersPanel from './HeadersPanel.svelte'
  import ParamsPanel from './ParamsPanel.svelte'
  import SettingsPanel from './SettingsPanel.svelte'
  import UrlBar from './UrlBar.svelte'
  import { tabsStore, type RequestSection, type RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()

  const sections = $derived.by(() => {
    const d = tab.draft
    const count = (n: number) => (n > 0 ? String(n) : undefined)
    return [
      { id: 'params', label: 'Params', badge: count(dataRows(d.params).filter((r) => r.enabled).length) },
      { id: 'auth', label: 'Authorization', badge: d.auth.kind !== 'none' ? '•' : undefined },
      { id: 'headers', label: 'Headers', badge: count(dataRows(d.headers).filter((r) => r.enabled).length) },
      { id: 'body', label: 'Body', badge: d.body.kind !== 'none' ? '•' : undefined },
      { id: 'docs', label: 'Docs' },
      { id: 'settings', label: 'Settings' },
      { id: 'code', label: 'Code' },
    ]
  })

  function send() {
    void tabsStore.send(tab)
  }
  function save() {
    if (tab.requestId) void tabsStore.save(tab)
    else ui.saveAsTabId = tab.id
  }
</script>

<div id="request-panel" role="tabpanel" aria-labelledby="rtab-{tab.id}" class="flex min-h-0 flex-1 flex-col">
  <div class="flex items-center gap-2 border-b border-border px-3 pt-2 text-xs text-muted">
    <label for="req-name-{tab.id}" class="sr-only">Request name</label>
    <input
      id="req-name-{tab.id}"
      type="text"
      class="min-w-0 max-w-md flex-1 !border-transparent !bg-transparent !px-1 text-sm font-medium text-fg hover:!border-border focus:!border-accent"
      value={tab.draft.name}
      oninput={(e) => (tab.draft.name = e.currentTarget.value)}
      placeholder="Request name"
    />
    {#if !tab.requestId}<span class="rounded bg-raised px-1.5 py-0.5">unsaved</span>{/if}
    <button type="button" class="ml-auto rounded px-2 py-1 hover:bg-hover" onclick={() => (ui.saveAsTabId = tab.id)}>Save As…</button>
  </div>
  <UrlBar {tab} onsend={send} oncancel={() => tabsStore.cancel(tab)} onsave={save} />
  <SplitPane direction="column" storageKey="slinger.split.request" initial={0.5} class="min-h-0">
    {#snippet first()}
      <div class="flex h-full min-h-0 flex-col">
        <Tabs tabs={sections} value={tab.section} onchange={(v) => (tab.section = v as RequestSection)} label="Request sections" idPrefix="sec" class="px-2" />
        <div class="min-h-0 flex-1 overflow-auto" role="tabpanel" id="sec-panel-{tab.section}" aria-labelledby="sec-{tab.section}">
          {#if tab.section === 'params'}<ParamsPanel {tab} />
          {:else if tab.section === 'auth'}<AuthPanel {tab} />
          {:else if tab.section === 'headers'}<HeadersPanel {tab} />
          {:else if tab.section === 'body'}<BodyPanel {tab} />
          {:else if tab.section === 'docs'}<DocsPanel {tab} />
          {:else if tab.section === 'settings'}<SettingsPanel {tab} />
          {:else}<CodePanel {tab} />
          {/if}
        </div>
      </div>
    {/snippet}
    {#snippet second()}
      <ResponsePane {tab} />
    {/snippet}
  </SplitPane>
</div>

{#if tab.conflict}<ConflictDialog {tab} />{/if}
