<script lang="ts">
  /**
   * "Extract to new collection": the folder becomes a collection of its own (electron/services/extractFolder.ts). Its
   * requests move (keeping history and examples), its subfolders come along, and it leaves the original collection.
   * Optionally the original collection's variables are copied and the scripts that used to run before the folder's
   * (collection, parent folders) are kept, so the requests behave as before.
   */
  import { untrack } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { countScripts, folderPath, mergeScripts, parseScriptsJson } from '../../lib/scripts'

  interface Props {
    folderId: string
    onclose: () => void
    /** Called with the new collection's id once it exists. */
    ondone?: (collectionId: string) => void
  }
  let { folderId, onclose, ondone }: Props = $props()

  const { folder, collection, subfolders, requests, inherited } = untrack(() => {
    const folder = app.folders.find((f) => f.id === folderId)!
    const collection = app.collections.find((c) => c.id === folder.collectionId)
    const all = app.foldersOf(folder.collectionId)
    const inTree = new Set([folder.id])
    for (let grew = true; grew; ) {
      grew = false
      for (const f of all) if (f.parentFolderId && inTree.has(f.parentFolderId) && !inTree.has(f.id)) (inTree.add(f.id), (grew = true))
    }
    // Scripts that ran before the folder's own: the collection's, then its parent folders' (outer to inner).
    const inherited = [
      ...(collection ? [{ label: `collection "${collection.name}"`, scriptsJson: collection.scriptsJson }] : []),
      ...folderPath(all, folder.parentFolderId).map((f) => ({ label: `folder "${f.name}"`, scriptsJson: f.scriptsJson })),
    ].filter((s) => countScripts(parseScriptsJson(s.scriptsJson)) > 0)
    return {
      folder,
      collection,
      subfolders: inTree.size - 1,
      requests: app.requestsOf(folder.collectionId).filter((r) => r.folderId && inTree.has(r.folderId)).length,
      inherited,
    }
  })
  const variableCount = (collection ? app.collectionVariables[collection.id] : undefined)?.length ?? 0

  let name = $state(untrack(() => folder.name))
  let copyVariables = $state(true)
  let keepScripts = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  const valid = $derived(name.trim().length > 0)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  async function submit(e?: Event) {
    e?.preventDefault()
    if (!valid || busy) return
    busy = true
    error = null
    try {
      const result = await api().extractFolderToCollection({
        folderId,
        name: name.trim(),
        // The folder's own scripts after the ones it inherited; absent: just the folder's own.
        ...(keepScripts && inherited.length > 0
          ? { scriptsJson: mergeScripts([...inherited, { label: `folder "${folder.name}"`, scriptsJson: folder.scriptsJson }]) }
          : {}),
        copyCollectionVariables: copyVariables && variableCount > 0,
      })
      await app.reloadCollections()
      toast.success(`"${result.collection.name}" is now a collection`, `${plural(result.requestCount, 'request')} moved out of "${collection?.name ?? 'the collection'}".`)
      ondone?.(result.collection.id)
      onclose()
    } catch (err) {
      error = errorInfo(err).message
    } finally {
      busy = false
    }
  }
</script>

<Dialog title="Extract to new collection" onclose={onclose} size="md" {busy}>
  <form id="extract-folder-form" class="flex flex-col gap-3 text-sm" onsubmit={submit}>
    <p data-testid="extract-summary">
      "{folder.name}" becomes a collection of its own with its {plural(requests, 'request')}{subfolders ? ` and ${plural(subfolders, 'subfolder')}` : ''},
      and leaves "{collection?.name ?? ''}". Requests keep their history, examples and docs.
    </p>
    <div class="flex flex-col gap-1">
      <label for="extract-name" class="text-xs text-muted">Collection name</label>
      <input id="extract-name" type="text" class="w-full" bind:value={name} data-autofocus autocomplete="off" onfocus={(e) => e.currentTarget.select()} />
    </div>
    {#if variableCount > 0}
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={copyVariables} />
        Copy the collection variables of "{collection?.name}" ({variableCount})
      </label>
    {/if}
    {#if inherited.length > 0}
      <span class="flex items-center gap-1">
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={keepScripts} />
          Keep the scripts that ran before this folder's
        </label>
        <InfoTip label="About inherited scripts">
          <span>
            Scripts of {inherited.map((s) => s.label).join(', ')} ran before this folder's requests. Kept, they are copied into the new
            collection's scripts ahead of the folder's own, each part marked with where it came from, so the requests keep behaving as before.
          </span>
        </InfoTip>
      </span>
    {/if}
    <InlineError message={error} />
  </form>
  {#snippet footer()}
    <Button onclick={onclose} disabled={busy}>Cancel</Button>
    <Button variant="primary" type="submit" form="extract-folder-form" loading={busy} disabled={!valid}>Extract</Button>
  {/snippet}
</Dialog>
