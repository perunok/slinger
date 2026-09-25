<script lang="ts">
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { suggestBumps } from '../../lib/semver'
  import { createFormState } from './helpers'

  interface Props {
    /** Versions that already exist for the collection. */
    existing: string[]
    requestCount: number
    folderCount: number
    /** Creates the version. A rejection is shown inline and keeps the dialog open. */
    oncreate: (version: string, notes: string | null) => Promise<void>
    onclose: () => void
  }
  let { existing, requestCount, folderCount, oncreate, onclose }: Props = $props()

  let version = $state('')
  let notes = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  const form = $derived(createFormState(version, existing))
  const bumps = $derived(suggestBumps(existing))
  const quick = $derived([
    { label: 'Patch', value: bumps.patch },
    { label: 'Minor', value: bumps.minor },
    { label: 'Major', value: bumps.major },
  ])

  async function submit() {
    if (!form.valid || busy) return
    busy = true
    error = null
    try {
      await oncreate(version, notes.trim() === '' ? null : notes.trim())
      onclose()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      void submit()
    }
  }
</script>

<Dialog title="Create version" {onclose} {busy} size="md">
  <div class="flex flex-col gap-3 text-sm">
    <p class="text-muted">
      A version is an immutable snapshot of this collection's folders and requests ({requestCount}
      request{requestCount === 1 ? '' : 's'}, {folderCount} folder{folderCount === 1 ? '' : 's'} right now). Unsaved editor tabs are not included.
    </p>
    <div class="flex flex-col gap-1">
      <label for="cv-version" class="text-xs font-medium">Version</label>
      <input
        id="cv-version"
        data-autofocus
        bind:value={version}
        {onkeydown}
        placeholder="e.g. 1.2.0 or 2.0.0-beta.1"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={form.reason ? true : undefined}
        aria-describedby="cv-version-msg"
        class="h-8 rounded border bg-raised px-2 font-mono text-sm outline-none focus:ring-2 focus:ring-focus {form.reason ? 'border-danger' : 'border-border'}"
      />
      <p id="cv-version-msg" class="min-h-4 text-xs text-danger" role={form.reason ? 'alert' : undefined}>{form.reason ?? ''}</p>
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted">Suggest:</span>
        {#each quick as q (q.label)}
          <Button size="sm" onclick={() => (version = q.value)} disabled={busy}>{q.label} {q.value}</Button>
        {/each}
      </div>
    </div>
    <div class="flex flex-col gap-1">
      <label for="cv-notes" class="text-xs font-medium">Notes <span class="font-normal text-faint">(optional)</span></label>
      <textarea
        id="cv-notes"
        bind:value={notes}
        rows="4"
        placeholder="What changed in this version?"
        class="resize-y rounded border border-border bg-raised px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-focus"
      ></textarea>
    </div>
    <InlineError message={error} />
  </div>
  {#snippet footer()}
    <Button onclick={onclose} disabled={busy}>Cancel</Button>
    <Button variant="primary" onclick={submit} disabled={!form.valid} loading={busy}>Create version</Button>
  {/snippet}
</Dialog>
