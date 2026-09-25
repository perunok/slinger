<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { findEnvByName } from '../environments/envLogic'
  import { describeEnvImport, importIntoEnvironment, planMerge, type ImportVar, type MergeMode } from './envImport'
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

  // An environment with the file's name already exists: the import merges into it.
  const existingEnv = $derived(parsed ? findEnvByName(app.environments, parsed.name) : null)
  // How many collection variables would be new in that environment (null while unknown).
  let newVarCount = $state<number | null>(null)
  $effect(() => {
    const env = existingEnv
    const file = parsed
    newVarCount = null
    if (!env || file?.kind !== 'collection') return
    let stale = false
    api()
      .listEnvironmentVariables(env.id)
      .then((vars) => {
        if (!stale) newVarCount = planMerge(vars, file.variables, 'keep').add.length
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  })

  async function importEnvironment(name: string, vars: ImportVar[], mode: MergeMode): Promise<string> {
    const ws = app.workspaceId
    if (!ws) throw new Error('No workspace is open')
    try {
      return describeEnvImport(await importIntoEnvironment(api(), ws, name, vars, mode))
    } finally {
      await app.reloadEnvironments()
    }
  }

  async function submit() {
    const file = parsed
    const ws = app.workspaceId
    if (!file || !ws || busy) return
    busy = true
    error = null
    try {
      if (file.kind === 'environment') {
        toast.success('Environment imported', await importEnvironment(file.name, file.variables, 'overwrite'))
        onclose()
        return
      }
      const result = await api().importPostmanCollection(ws, text)
      await app.reloadCollections()
      let envError: string | null = null
      let envSummary: string | null = null
      if (makeEnv && file.variables.length > 0) {
        try {
          envSummary = await importEnvironment(file.name, file.variables, 'keep')
        } catch (e) {
          envError = errorInfo(e).message
        }
      }
      const scripts = result.scriptCount ?? 0
      toast.success(
        'Collection imported',
        `${result.collection.name}: ${result.requests.length} request${result.requests.length === 1 ? '' : 's'}${scripts ? `, ${scripts} script${scripts === 1 ? '' : 's'}` : ''}`,
      )
      if (envSummary) toast.success('Environment from collection variables', envSummary)
      if (envError) toast.error('Collection imported, but the environment could not be created or updated', envError)
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
          <dt class="text-muted">Saved examples</dt><dd data-testid="import-examples">{parsed.examples}</dd>
          <dt class="text-muted">Scripts</dt><dd data-testid="import-scripts">{parsed.scripts > 0 ? `${parsed.scripts} (pre-request and test, all levels)` : 'none'}</dd>
          <dt class="text-muted">Collection variables</dt><dd>{parsed.variables.length > 0 ? `${parsed.variables.length} defined` : 'none'}</dd>
        </dl>
        {#if parsed.variables.length > 0}
          <label class="flex items-start gap-2">
            <input type="checkbox" bind:checked={makeEnv} class="mt-0.5" />
            <span>
              Create or update environment "{parsed.name}" from collection variables
              <span class="block text-xs text-muted" data-testid="import-env-help">
                The importer does not keep collection-level variables.
                {#if existingEnv}
                  {#if newVarCount === null}
                    Adds the missing variables to the existing environment "{existingEnv.name}"; existing values are kept.
                  {:else}
                    Adds {newVarCount} new variable{newVarCount === 1 ? '' : 's'} to the existing environment "{existingEnv.name}"; existing
                    values are kept.
                  {/if}
                {:else}
                  This creates an environment named "{parsed.name}" with {parsed.variables.length} variable{parsed.variables.length === 1
                    ? ''
                    : 's'} so {'{{'}placeholders{'}}'} keep working.
                {/if}
              </span>
            </span>
          </label>
        {:else}
          <p class="text-xs text-muted">The collection has no collection-level variables.</p>
        {/if}
      {:else if parsed?.kind === 'environment'}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
          <dt class="text-muted">Environment</dt><dd class="font-medium">{parsed.name}</dd>
          <dt class="text-muted">Variables</dt><dd>{parsed.variables.length} ({parsed.variables.filter((v) => v.secret).length} secret)</dd>
        </dl>
        {#if existingEnv}
          <p class="text-xs text-muted" data-testid="import-env-help">
            An environment named "{existingEnv.name}" already exists: missing variables are added and
            existing ones take the values from this file. Empty values in the file keep the current value.
          </p>
        {/if}
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
