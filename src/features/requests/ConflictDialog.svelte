<script lang="ts">
  /** Shown when updateRequest reports version_conflict: the request changed elsewhere. */
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { tabsStore, type RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function run(fn: () => Promise<unknown>) {
    busy = true
    error = null
    try {
      await fn()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }
  const reload = () => run(() => tabsStore.reloadFromServer(tab))
  const overwrite = () =>
    run(async () => {
      const ok = await tabsStore.save(tab, { overwrite: true })
      if (!ok && tab.conflict) throw new Error('Could not overwrite: the request changed again. Try once more.')
    })
</script>

<Dialog title="Request changed elsewhere" onclose={() => (tab.conflict = null)} size="md" {busy}>
  <p class="text-sm">
    “{tab.title}” was modified after you opened it (stored version {tab.conflict?.serverRequest?.version ?? '?'}, yours is based on {tab.baseVersion}).
  </p>
  <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
    <li><strong class="text-fg">Reload</strong> discards your edits and loads the stored version.</li>
    <li><strong class="text-fg">Overwrite</strong> saves your edits over the stored version.</li>
    <li><strong class="text-fg">Cancel</strong> keeps your unsaved edits in the tab.</li>
  </ul>
  <InlineError class="mt-3" message={error} />
  {#snippet footer()}
    <Button onclick={() => (tab.conflict = null)} disabled={busy}>Cancel</Button>
    <Button onclick={reload} disabled={busy}>Reload from stored</Button>
    <Button variant="danger" onclick={overwrite} loading={busy}>Overwrite</Button>
  {/snippet}
</Dialog>
