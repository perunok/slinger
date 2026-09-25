<script lang="ts">
  /**
   * Collection- or folder-level scripts. They run for every request inside, before the request's own script:
   * collection -> folders (outer to inner) -> request, for pre-request and for tests. Stored on the collection /
   * folder as the Postman `event` array (local-only in v1: cloud sync does not carry them).
   */
  import { untrack } from 'svelte'
  import type { ApiFolder } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { editorCode, parseScriptsJson, scriptsJsonOf, withScript, type ScriptListen } from '../../lib/scripts'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import ScriptEditors from './ScriptEditors.svelte'

  let { target, onclose }: { target: { kind: 'collection' | 'folder'; id: string }; onclose: () => void } = $props()

  const { kind, entity } = untrack(() => ({
    kind: target.kind,
    entity: target.kind === 'collection' ? app.collections.find((c) => c.id === target.id) : app.folders.find((f) => f.id === target.id),
  }))
  const original = parseScriptsJson(entity?.scriptsJson)
  let prerequest = $state(editorCode(original, 'prerequest'))
  let test = $state(editorCode(original, 'test'))
  let active = $state<ScriptListen>('prerequest')
  let saving = $state(false)
  let error = $state<string | null>(null)

  const next = $derived(withScript(withScript(original, 'prerequest', prerequest), 'test', test))
  const dirty = $derived(next !== original)

  async function save() {
    if (!entity || sync.blocked) return
    saving = true
    error = null
    try {
      const json = scriptsJsonOf(next)
      if (kind === 'collection') await api().setCollectionScripts(entity.id, json)
      else await api().setFolderScripts(entity.id, json)
      if (kind === 'folder') await app.reloadCollection((entity as ApiFolder).collectionId)
      else await app.reloadCollections()
      toast.success('Scripts saved', `${kind === 'collection' ? 'Collection' : 'Folder'} “${entity.name}”`)
      onclose()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      saving = false
    }
  }
</script>

<Dialog title="Scripts: {kind} “{entity?.name ?? ''}”" {onclose} busy={saving} size="lg">
  <div class="flex h-[60vh] min-h-0 flex-col gap-2 text-sm">
    <ReadOnlyNote />
    <p class="text-xs text-muted">
      Runs for every request in this {kind}{kind === 'folder' ? ' (after the collection script, before the request script)' : ' (before folder and request scripts)'}.
      Scripts of a {kind} are kept on this device only; cloud sync does not carry them yet.
    </p>
    <ScriptEditors
      {prerequest}
      {test}
      onchange={(listen, code) => (listen === 'prerequest' ? (prerequest = code) : (test = code))}
      {active}
      onactivechange={(v) => (active = v)}
      readOnly={sync.blocked}
      idPrefix="{kind}-{target.id.slice(0, 8)}"
      class="min-h-0 flex-1 rounded border border-border"
    />
    <InlineError message={error} />
  </div>
  {#snippet footer()}
    <Button onclick={onclose} disabled={saving}>Cancel</Button>
    <Button variant="primary" loading={saving} disabled={!dirty || sync.blocked || !entity} title={sync.blocked ? sync.blockedMessage : undefined} onclick={save}>Save</Button>
  {/snippet}
</Dialog>
