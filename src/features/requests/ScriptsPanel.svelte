<script lang="ts">
  /** Request-level scripts, stored in the request document as Postman `event` entries (key `scripts`). */
  import { editorCode, folderPath, parseScriptsJson, runnableCode, withScript, type ScriptListen } from '../../lib/scripts'
  import { app } from '../../app/state.svelte'
  import ScriptEditors from '../scripts/ScriptEditors.svelte'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()

  const events = $derived(tab.draft.extras.scripts)
  const prerequest = $derived(editorCode(events, 'prerequest'))
  const test = $derived(editorCode(events, 'test'))

  function onchange(listen: ScriptListen, code: string) {
    const next = withScript(tab.draft.extras.scripts, listen, code)
    if (next === tab.draft.extras.scripts) return
    const extras = { ...tab.draft.extras }
    // No scripts at all: drop the key again unless the stored document had it (keeps the saved fingerprint).
    if (next.length === 0 && tab.draft.extras.scripts === undefined) delete extras.scripts
    else extras.scripts = next
    tab.draft.extras = extras
  }

  /** Which outer scripts also run for this request (collection / folders), so authors know the order. */
  const inherited = $derived.by(() => {
    if (!tab.collectionId) return ''
    const listen = tab.scriptsView
    const names: string[] = []
    const col = app.collections.find((c) => c.id === tab.collectionId)
    if (col && runnableCode(parseScriptsJson(col.scriptsJson), listen)) names.push(`collection “${col.name}”`)
    for (const f of folderPath(app.foldersOf(tab.collectionId), tab.folderId)) {
      if (runnableCode(parseScriptsJson(f.scriptsJson), listen)) names.push(`folder “${f.name}”`)
    }
    return names.length ? `Runs after the ${names.join(', then ')} script.` : ''
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if sync.blocked}<ReadOnlyNote class="mx-3 mt-2" />{/if}
  <ScriptEditors
    {prerequest}
    {test}
    {onchange}
    active={tab.scriptsView}
    onactivechange={(v) => (tab.scriptsView = v)}
    readOnly={sync.blocked}
    idPrefix="req-{tab.id}"
    scopeHint={inherited}
    class="min-h-0 flex-1"
  />
</div>
