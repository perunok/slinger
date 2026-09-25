<script lang="ts">
  import { METHODS } from '../../lib/request'
  import { mergeParamsFromUrl } from '../../lib/urlParams'
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { ui } from '../../app/ui.svelte'
  import { detectImportText } from '../importexport/parse'
  import { sync } from '../sync/syncStore.svelte'
  import { methodColor } from './method'
  import type { RequestTab } from './tabs.svelte'

  interface Props {
    tab: RequestTab
    onsend: () => void
    oncancel: () => void
    onsave: () => void
    /** Example tabs label the send button "Try" (it sends from a new tab). */
    sendLabel?: string
    sendTitle?: string
  }
  let { tab, onsend, oncancel, onsave, sendLabel = 'Send', sendTitle = 'Send (Ctrl+Enter)' }: Props = $props()

  function setUrl(v: string) {
    tab.draft.url = v
    tab.draft.params = mergeParamsFromUrl(v, tab.draft.params)
  }

  /**
   * A collection or environment export pasted into the URL bar opens the Import dialog with it instead of
   * becoming the URL. Anything else (URLs, `{{vars}}`, query strings, small JSON) pastes as usual.
   */
  function onpastetext(text: string): boolean {
    if (sync.blocked || !detectImportText(text)) return false
    ui.openImport(text)
    return true
  }
</script>

<div class="flex items-center gap-2 px-3 py-2" role="group" aria-label="Request URL">
  <select
    aria-label="HTTP method"
    class="h-8 w-28 shrink-0 font-semibold"
    style="color:{methodColor(tab.draft.method)}"
    value={tab.draft.method}
    onchange={(e) => (tab.draft.method = e.currentTarget.value)}
  >
    {#each METHODS as m (m)}<option value={m}>{m}</option>{/each}
    {#if !(METHODS as readonly string[]).includes(tab.draft.method)}<option value={tab.draft.method}>{tab.draft.method}</option>{/if}
  </select>
  <div class="flex h-8 min-w-0 flex-1 items-center rounded border border-border bg-surface px-1 focus-within:border-accent">
    <TemplateInput
      class="w-full !border-transparent"
      mono
      label="Request URL"
      placeholder="https://api.example.com/resource?key={'{{'}value{'}}'}"
      value={tab.draft.url}
      oninput={setUrl}
      onenter={onsend}
      {onpastetext}
    />
  </div>
  {#if tab.sending}
    <Button variant="danger" icon="stop" onclick={oncancel} class="w-24">Cancel</Button>
  {:else}
    <Button variant="primary" icon="send" onclick={onsend} class="w-24" title={sendTitle}>{sendLabel}</Button>
  {/if}
  <Button icon="save" onclick={onsave} loading={tab.saving} title={sync.blocked ? `${sync.blockedMessage} Saving is disabled.` : 'Save (Ctrl+S)'} disabled={sync.blocked || (!!tab.requestId && !tab.dirty)}>Save</Button>
</div>
