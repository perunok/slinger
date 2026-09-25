<script lang="ts">
  /**
   * An open saved example: its request (method, URL, params, auth, headers, body) on top and its saved
   * response below. Both halves are editable; Save writes the example back into the parent request.
   * "Try" sends the request from a new tab and leaves the example alone.
   */
  import { app } from '../../app/state.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import SplitPane from '../../components/ui/SplitPane.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { dataRows } from '../../lib/kv'
  import AuthPanel from '../requests/AuthPanel.svelte'
  import BodyPanel from '../requests/BodyPanel.svelte'
  import ConflictDialog from '../requests/ConflictDialog.svelte'
  import HeadersPanel from '../requests/HeadersPanel.svelte'
  import ParamsPanel from '../requests/ParamsPanel.svelte'
  import UrlBar from '../requests/UrlBar.svelte'
  import { tabsStore, type RequestSection, type RequestTab } from '../requests/tabs.svelte'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import TabNoticeBanner from '../sync/TabNoticeBanner.svelte'
  import ExampleResponseEditor from './ExampleResponseEditor.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const parent = $derived(app.requestById(tab.requestId))
  const ex = $derived(tab.example!)
  const draft = $derived(tab.exampleDraft!)

  const SECTIONS: RequestSection[] = ['params', 'auth', 'headers', 'body']
  const section = $derived(SECTIONS.includes(tab.section) ? tab.section : 'params')
  const sections = $derived.by(() => {
    const d = tab.draft
    const count = (n: number) => (n > 0 ? String(n) : undefined)
    return [
      { id: 'params', label: 'Params', badge: count(dataRows(d.params).filter((r) => r.enabled).length) },
      { id: 'auth', label: 'Authorization', badge: d.auth.kind !== 'none' ? '•' : undefined },
      { id: 'headers', label: 'Headers', badge: count(dataRows(d.headers).filter((r) => r.enabled).length) },
      { id: 'body', label: 'Body', badge: d.body.kind !== 'none' ? '•' : undefined },
    ]
  })

  function save() {
    if (sync.blocked) return
    void tabsStore.save(tab)
  }
  function openParent() {
    if (parent) tabsStore.openRequest(parent)
  }
</script>

<div id="request-panel" role="tabpanel" aria-labelledby="rtab-{tab.id}" class="flex min-h-0 flex-1 flex-col" data-testid="example-view">
  <div class="flex items-center gap-2 border-b border-border px-3 pt-2 text-xs text-muted">
    <span class="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 font-medium text-fg">Example</span>
    {#if parent}
      <button type="button" class="min-w-0 max-w-[40%] truncate rounded px-1 hover:bg-hover hover:text-fg" title="Open the request “{parent.name}”" onclick={openParent}>{parent.name}</button>
      <span aria-hidden="true">/</span>
    {/if}
    <label for="ex-name-{tab.id}" class="sr-only">Example name</label>
    <input
      id="ex-name-{tab.id}"
      type="text"
      class="min-w-0 max-w-md flex-1 !border-transparent !bg-transparent !px-1 text-sm font-medium text-fg hover:!border-border focus:!border-accent"
      value={draft.name}
      oninput={(e) => (draft.name = e.currentTarget.value)}
      placeholder="Example name"
    />
    {#if ex.requestFromParent}
      <span class="shrink-0 rounded bg-raised px-1.5 py-0.5" title="This example has no saved request of its own; the request part shows the parent request. Editing it saves a copy into the example.">request from parent</span>
    {/if}
  </div>
  <TabNoticeBanner {tab} />
  {#if ex.remote === 'gone' && tab.remoteNotice?.kind !== 'deleted'}
    <div role="status" class="flex items-center gap-2 border-b border-warning bg-warning-soft px-3 py-1.5 text-xs" data-testid="example-gone">
      <span class="text-warning"><Icon name="alert" size={14} /></span>
      This example was deleted elsewhere. Your edits are kept here; saving adds it back.
    </div>
  {/if}
  {#if sync.blocked && tab.dirty}<ReadOnlyNote class="mx-3 mt-2" />{/if}
  <UrlBar
    {tab}
    onsend={() => tabsStore.tryExample(tab)}
    oncancel={() => {}}
    onsave={save}
    sendLabel="Try"
    sendTitle="Send this request from a new tab; the example is not changed (Ctrl+Enter)"
  />
  <SplitPane direction="column" storageKey="slinger.split.example" initial={0.45} class="min-h-0">
    {#snippet first()}
      <div class="flex h-full min-h-0 flex-col">
        <Tabs tabs={sections} value={section} onchange={(v) => (tab.section = v as RequestSection)} label="Example request sections" idPrefix="exsec" class="px-2" />
        <div class="min-h-0 flex-1 overflow-auto" role="tabpanel" id="exsec-panel-{section}" aria-labelledby="exsec-{section}">
          {#if section === 'params'}<ParamsPanel {tab} />
          {:else if section === 'auth'}<AuthPanel {tab} />
          {:else if section === 'headers'}<HeadersPanel {tab} />
          {:else}<BodyPanel {tab} />
          {/if}
        </div>
      </div>
    {/snippet}
    {#snippet second()}
      <ExampleResponseEditor {tab} />
    {/snippet}
  </SplitPane>
</div>

{#if tab.conflict}<ConflictDialog {tab} />{/if}
