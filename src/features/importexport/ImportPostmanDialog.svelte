<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { parsePostmanFile, type PostmanFile } from './parse'

  interface Props {
    open: boolean
    onclose: () => void
  }
  let { open, onclose }: Props = $props()

  let fileName = $state<string | null>(null)
  let text = $state('')
  let parsed = $state.raw<PostmanFile | null>(null)
  let error = $state<string | null>(null)
  let makeEnv = $state(true)
  let busy = $state(false)
  let dragging = $state(false)
  let input: HTMLInputElement | undefined = $state()

  $effect(() => {
    if (!open) {
      fileName = null
      text = ''
      parsed = null
      error = null
      makeEnv = true
      busy = false
      dragging = false
    }
  })

  function readText(file: File): Promise<string> {
    if (typeof file.text === 'function') return file.text()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('read failed'))
      reader.readAsText(file)
    })
  }

  async function load(file: File | null | undefined) {
    if (!file) return
    fileName = file.name
    parsed = null
    error = null
    try {
      text = await readText(file)
    } catch (e) {
      text = ''
      error = `Could not read the file: ${errorInfo(e).message}`
      return
    }
    const r = parsePostmanFile(text)
    if (r.ok) parsed = r.file
    else error = r.error
  }

  function ondrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    void load(e.dataTransfer?.files?.[0])
  }

  async function createEnvironment(name: string, vars: { key: string; value: string; secret: boolean }[]): Promise<void> {
    const ws = app.workspaceId
    if (!ws) throw new Error('No workspace is open')
    const env = await api().createEnvironment(ws, name)
    for (const v of vars) {
      await api().upsertEnvironmentVariable({ environmentId: env.id, key: v.key, value: v.value, isSecret: v.secret })
    }
    await app.reloadEnvironments()
  }

  async function submit() {
    const file = parsed
    const ws = app.workspaceId
    if (!file || !ws || busy) return
    busy = true
    error = null
    try {
      if (file.kind === 'environment') {
        await createEnvironment(file.name, file.variables)
        toast.success('Environment imported', `${file.name}: ${file.variables.length} variable${file.variables.length === 1 ? '' : 's'}`)
        onclose()
        return
      }
      const result = await api().importPostmanCollection(ws, text)
      await app.reloadCollections()
      let envError: string | null = null
      if (makeEnv && file.variables.length > 0) {
        try {
          await createEnvironment(file.name, file.variables)
        } catch (e) {
          envError = errorInfo(e).message
        }
      }
      toast.success('Collection imported', `${result.collection.name}: ${result.requests.length} request${result.requests.length === 1 ? '' : 's'}`)
      if (envError) toast.error('Collection imported, but the environment could not be created', envError)
      onclose()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <Dialog title="Import from Postman" {onclose} {busy} size="md">
    <div class="flex flex-col gap-3 text-sm">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex flex-col items-center gap-2 rounded border border-dashed px-4 py-6 text-center {dragging ? 'border-accent bg-accent-soft' : 'border-border bg-raised'}"
        ondragover={(e) => {
          e.preventDefault()
          dragging = true
        }}
        ondragleave={() => (dragging = false)}
        {ondrop}
      >
        <p class="text-muted">Drop a Postman collection (v2.x) or environment .json here</p>
        <input
          bind:this={input}
          id="pm-file"
          type="file"
          accept=".json,application/json"
          class="sr-only"
          aria-label="Postman file"
          onchange={(e) => load(e.currentTarget.files?.[0])}
        />
        <Button onclick={() => input?.click()} disabled={busy}>Choose file</Button>
        {#if fileName}<p class="text-xs text-muted">{fileName}</p>{/if}
      </div>

      <InlineError message={error} />

      {#if parsed?.kind === 'collection'}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
          <dt class="text-muted">Collection</dt><dd class="font-medium">{parsed.name}</dd>
          <dt class="text-muted">Folders</dt><dd>{parsed.folders}</dd>
          <dt class="text-muted">Requests</dt><dd>{parsed.requests}</dd>
          <dt class="text-muted">Collection variables</dt><dd>{parsed.variables.length > 0 ? `${parsed.variables.length} defined` : 'none'}</dd>
        </dl>
        {#if parsed.variables.length > 0}
          <label class="flex items-start gap-2">
            <input type="checkbox" bind:checked={makeEnv} class="mt-0.5" />
            <span>
              Create environment from collection variables
              <span class="block text-xs text-muted">
                The importer does not keep collection-level variables. This creates an environment named "{parsed.name}" with
                {parsed.variables.length} variable{parsed.variables.length === 1 ? '' : 's'} so {'{{'}placeholders{'}}'} keep working.
              </span>
            </span>
          </label>
        {:else}
          <p class="text-xs text-muted">Collection-level variables, scripts and tests are not imported.</p>
        {/if}
      {:else if parsed?.kind === 'environment'}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
          <dt class="text-muted">Environment</dt><dd class="font-medium">{parsed.name}</dd>
          <dt class="text-muted">Variables</dt><dd>{parsed.variables.length} ({parsed.variables.filter((v) => v.secret).length} secret)</dd>
        </dl>
        {#if parsed.skippedDisabled > 0}
          <p class="text-xs text-muted">{parsed.skippedDisabled} disabled variable{parsed.skippedDisabled === 1 ? ' is' : 's are'} skipped.</p>
        {/if}
      {/if}
    </div>
    {#snippet footer()}
      <Button onclick={onclose} disabled={busy}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!parsed} onclick={submit}>Import</Button>
    {/snippet}
  </Dialog>
{/if}
