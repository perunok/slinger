<script lang="ts">
  import type { CollectionVersion, RestoreCollectionVersionMode } from '../../../shared/types'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { copyName } from './helpers'

  interface Props {
    version: CollectionVersion
    collectionName: string
    /** Performs the restore. Rejections are shown inline. */
    onrestore: (mode: RestoreCollectionVersionMode) => Promise<void>
    /** Opens the create-version dialog (used from the replace confirmation). */
    oncreateFirst: () => void
    onclose: () => void
  }
  let { version, collectionName, onrestore, oncreateFirst, onclose }: Props = $props()

  let mode = $state<RestoreCollectionVersionMode>('copy')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let confirming = $state(false)

  async function run() {
    busy = true
    error = null
    try {
      await onrestore(mode)
      onclose()
    } catch (e) {
      error = errorInfo(e).message
      throw e
    } finally {
      busy = false
    }
  }

  function start() {
    if (mode === 'replace') confirming = true
    else void run().catch(() => {})
  }

  const options = $derived([
    {
      id: 'copy' as const,
      title: `Restore as a new collection named "${copyName(collectionName, version.version)}"`,
      hint: 'The live collection is untouched.',
    },
    {
      id: 'replace' as const,
      title: 'Replace the live collection',
      hint: 'Overwrites its folders and requests with this version.',
    },
  ])
</script>

<Dialog title="Restore v{version.version}" {onclose} {busy} size="md">
  <fieldset class="flex flex-col gap-2 text-sm" disabled={busy}>
    <legend class="mb-1 text-xs font-medium">How do you want to restore?</legend>
    {#each options as o (o.id)}
      <label
        class="flex cursor-pointer items-start gap-2 rounded border p-2.5 focus-within:ring-2 focus-within:ring-focus {mode === o.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover'}"
      >
        <input type="radio" name="restore-mode" value={o.id} bind:group={mode} class="mt-1" />
        <span>
          <span class="block font-medium">{o.title}</span>
          <span class="block text-xs text-muted">{o.hint}</span>
        </span>
      </label>
    {/each}
  </fieldset>
  {#if mode === 'replace'}
    <p role="alert" class="mt-3 rounded border border-warning bg-warning-soft px-2 py-1.5 text-xs text-warning">
      Warning: this permanently overwrites the current folders and requests of "{collectionName}". Changes made since this version
      was created will be lost.
    </p>
  {/if}
  <InlineError message={error} class="mt-3" />
  {#snippet footer()}
    <Button onclick={onclose} disabled={busy}>Cancel</Button>
    <Button variant={mode === 'replace' ? 'danger' : 'primary'} onclick={start} loading={busy && !confirming}>
      {mode === 'replace' ? 'Replace collection...' : 'Restore as copy'}
    </Button>
  {/snippet}
</Dialog>

{#if confirming}
  <ConfirmDialog
    title="Overwrite live collection?"
    message={`This overwrites the live collection "${collectionName}" with v${version.version}. Anything not saved in a version will be lost. Consider creating a version of the current state first.`}
    confirmLabel="Replace collection"
    danger
    onconfirm={run}
    oncancel={() => (confirming = false)}
  >
    {#snippet extra()}
      <div class="mt-3">
        <Button size="sm" onclick={() => { confirming = false; oncreateFirst() }}>Create a version first</Button>
      </div>
    {/snippet}
  </ConfirmDialog>
{/if}
