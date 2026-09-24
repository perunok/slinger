<script lang="ts">
  /** Save a tab as a request in a chosen collection/folder. Stays open (with the error) if saving fails. */
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { tabsStore } from './tabs.svelte'

  const tab = $derived(tabsStore.find(ui.saveAsTabId))

  let name = $state('')
  let collectionId = $state('')
  let folderId = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let initialisedFor: string | null = null

  $effect(() => {
    if (tab && initialisedFor !== tab.id) {
      initialisedFor = tab.id
      name = tab.draft.name
      collectionId = tab.collectionId ?? app.collections[0]?.id ?? ''
      folderId = tab.folderId ?? ''
      error = null
    }
    if (!tab) initialisedFor = null
  })

  interface Option {
    id: string
    label: string
  }
  const folderOptions = $derived.by<Option[]>(() => {
    const all = app.foldersOf(collectionId)
    const out: Option[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const f of all.filter((x) => x.parentFolderId === parent).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
        out.push({ id: f.id, label: `${'  '.repeat(depth)}${f.name}` })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  })

  function close() {
    ui.saveAsTabId = null
  }

  async function submit(e?: Event) {
    e?.preventDefault()
    if (!tab || !name.trim() || !collectionId) return
    busy = true
    error = null
    try {
      await tabsStore.saveAs(tab, { collectionId, folderId: folderId || null, name: name.trim() })
      toast.success('Request saved')
      close()
    } catch (err) {
      error = errorInfo(err).message
    } finally {
      busy = false
    }
  }
</script>

{#if tab}
  <Dialog title="Save request" onclose={close} size="sm" {busy}>
    <form id="saveas-form" class="grid gap-3" onsubmit={submit}>
      <div class="grid gap-1">
        <label for="sa-name" class="text-xs text-muted">Request name</label>
        <input id="sa-name" type="text" bind:value={name} data-autofocus autocomplete="off" />
      </div>
      {#if app.collections.length === 0}
        <p class="rounded border border-warning bg-warning-soft px-2 py-1.5 text-sm">Create a collection first (use the + button in the Collections sidebar).</p>
      {:else}
        <div class="grid gap-1">
          <label for="sa-col" class="text-xs text-muted">Collection</label>
          <select id="sa-col" bind:value={collectionId} onchange={() => (folderId = '')}>
            {#each app.collections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select>
        </div>
        <div class="grid gap-1">
          <label for="sa-folder" class="text-xs text-muted">Folder</label>
          <select id="sa-folder" bind:value={folderId}>
            <option value="">(collection root)</option>
            {#each folderOptions as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
          </select>
        </div>
      {/if}
      <InlineError message={error} />
    </form>
    {#snippet footer()}
      <Button onclick={close} disabled={busy}>Cancel</Button>
      <Button variant="primary" type="submit" form="saveas-form" loading={busy} disabled={!name.trim() || !collectionId}>Save</Button>
    {/snippet}
  </Dialog>
{/if}
