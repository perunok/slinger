<script lang="ts">
  /** Right panel > Docs: the active request's documentation, rendered (read only), with a way to edit it. */
  import { app } from '../../../app/state.svelte'
  import MarkdownView from '../../../components/markdown/MarkdownView.svelte'
  import Button from '../../../components/ui/Button.svelte'
  import { readDescription } from '../../../lib/description'
  import { tabsStore, type RequestTab } from '../../requests/tabs.svelte'
  import PanelEmpty from './PanelEmpty.svelte'

  let { tab }: { tab: RequestTab | null } = $props()

  const parent = $derived(tab?.example ? app.requestById(tab.requestId) : undefined)
  /** A request tab shows its (possibly unsaved) draft; an example tab its parent request's stored docs. */
  const docs = $derived.by(() => {
    if (!tab) return null
    if (!tab.example) return { text: tab.draft.description, format: readDescription(tab.draft.descriptionSource).format }
    if (!parent) return null
    try {
      return readDescription((JSON.parse(parent.documentJson || '{}') as { description?: unknown } | null)?.description)
    } catch {
      return null
    }
  })

  function edit() {
    if (!tab) return
    if (tab.example) {
      if (!parent) return
      const t = tabsStore.openRequest(parent)
      t.section = 'docs'
    } else {
      tab.section = 'docs'
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="panel-docs">
  {#if !tab}
    <PanelEmpty><p>Open a request to read its documentation.</p></PanelEmpty>
  {:else}
    <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
      <span class="min-w-0 truncate text-xs text-muted">{tab.example ? `Documentation of “${parent?.name ?? 'the request'}”` : 'Request documentation'}</span>
      <Button size="sm" icon="edit" class="ml-auto shrink-0" disabled={tab.example ? !parent : false} onclick={edit}>{tab.example ? 'Open request' : 'Edit in Docs'}</Button>
    </div>
    {#if docs?.text.trim()}
      <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
        <MarkdownView source={docs.text} format={docs.format} label="Request documentation" />
      </div>
    {:else}
      <PanelEmpty>
        <p>{tab.example ? 'The request has no documentation.' : 'This request has no documentation yet.'}</p>
        {#if !tab.example}<Button size="sm" icon="edit" onclick={edit}>Write documentation</Button>{/if}
      </PanelEmpty>
    {/if}
  {/if}
</div>
