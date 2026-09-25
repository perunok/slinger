<script lang="ts">
  import { expandedStore } from '../../app/expanded.svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { findEnvByName } from '../environments/envLogic'
  import { tabsStore } from '../requests/tabs.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import { mapRestored, remapExpandedKeys } from '../versions/restoreRemap'
  import { describeEnvImport, importIntoEnvironment, planMerge, type ImportVar, type MergeMode } from './envImport'
  import { parsePostmanFile, type PostmanFile } from './parse'
  import { copyName, findReimportMatches } from './reimport'

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
  /** Re-import of an existing collection: replace it (default) or import as a copy. */
  let mode = $state<'replace' | 'copy'>('replace')
  let targetId = $state<string | null>(null)

  $effect(() => {
    if (!open) {
      fileName = null
      text = ''
      parsed = null
      error = null
      makeEnv = true
      busy = false
      dragging = false
      mode = 'replace'
      targetId = null
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
    mode = 'replace'
    targetId = null
  }

  function ondrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    void load(e.dataTransfer?.files?.[0])
  }

  // Live collections of this workspace the file matches (by _postman_id, else by name).
  const match = $derived(parsed?.kind === 'collection' ? findReimportMatches(app.collections, parsed) : null)
  const target = $derived(match ? (match.collections.find((c) => c.id === targetId) ?? match.collections[0]!) : null)
  // Default target: the first match (kept while it still matches).
  $effect(() => {
    if (match && !match.collections.some((c) => c.id === targetId)) targetId = match.collections[0]!.id
  })
  // Read-only (viewer) or revoked workspaces cannot be changed: replacing is not offered.
  const replaceDisabled = $derived(sync.blocked)
  const choice = $derived<'replace' | 'copy' | null>(match ? (mode === 'replace' && !replaceDisabled ? 'replace' : 'copy') : null)
  const copyAs = $derived(parsed ? copyName(parsed.name, app.collections.map((c) => c.name)) : '')
  const requestCountOf = (collectionId: string) => app.requestsOf(collectionId).length
  function describeTarget(c: { id: string; name: string; createdAt: number }): string {
    const n = requestCountOf(c.id)
    return `${c.name} (${n} request${n === 1 ? '' : 's'}, created ${new Date(c.createdAt * 1000).toLocaleDateString()})`
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

  /**
   * Replaces the collection in place (the backend snapshots it first). Every folder/request gets a new id, so
   * the old layout is mapped onto the new one by path (as after a version restore): expanded folders stay open
   * and clean tabs follow their request; dirty tabs are kept detached by the reconcile, never overwritten.
   */
  async function replaceExisting(collectionId: string, name: string): Promise<[string, string]> {
    const before = { folders: app.foldersOf(collectionId).slice(), requests: app.requestsOf(collectionId).slice() }
    const result = await api().replaceCollectionFromPostman(collectionId, text, fileName)
    const map = mapRestored(before, { folders: result.folders, requests: result.requests })
    expandedStore.replace(remapExpandedKeys(expandedStore.keys, map.folders, new Set(before.folders.map((f) => f.id))))
    tabsStore.followReplaced(map.requests)
    await app.reloadCollections()
    const n = result.requests.length
    return [
      'Collection replaced',
      `"${name}" now has ${n} request${n === 1 ? '' : 's'}. The previous content was saved as version ${result.safetyVersion.version}.`,
    ]
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
      let summary: [string, string]
      if (choice === 'replace' && target) {
        summary = await replaceExisting(target.id, target.name)
      } else {
        const result = choice === 'copy' ? await api().importPostmanCollection(ws, text, { name: copyAs }) : await api().importPostmanCollection(ws, text)
        await app.reloadCollections()
        const scripts = result.scriptCount ?? 0
        summary = [
          'Collection imported',
          `${result.collection.name}: ${result.requests.length} request${result.requests.length === 1 ? '' : 's'}${scripts ? `, ${scripts} script${scripts === 1 ? '' : 's'}` : ''}`,
        ]
      }
      let envError: string | null = null
      let envSummary: string | null = null
      if (makeEnv && file.variables.length > 0) {
        try {
          envSummary = await importEnvironment(file.name, file.variables, 'keep')
        } catch (e) {
          envError = errorInfo(e).message
        }
      }
      toast.success(...summary)
      if (envSummary) toast.success('Environment from collection variables', envSummary)
      if (envError) toast.error(`${summary[0]}, but the environment could not be created or updated`, envError)
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
        {#if match && target}
          <fieldset class="flex flex-col gap-2" disabled={busy} data-testid="reimport-choice">
            <legend class="mb-1 text-xs font-medium">
              {match.collections.length === 1
                ? `This collection already exists in the workspace${match.by === 'id' ? '' : ' (same name)'}.`
                : `${match.collections.length} collections in the workspace match this file${match.by === 'id' ? '' : ' by name'}.`}
            </legend>
            <label
              class="flex items-start gap-2 rounded border p-2.5 {replaceDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer focus-within:ring-2 focus-within:ring-focus'} {choice === 'replace' ? 'border-accent bg-accent-soft' : 'border-border'} {replaceDisabled ? '' : 'hover:bg-hover'}"
            >
              <input type="radio" name="reimport-mode" value="replace" checked={choice === 'replace'} onchange={() => (mode = 'replace')} disabled={replaceDisabled} class="mt-1" aria-describedby="reimport-replace-hint" />
              <span>
                <span class="block font-medium">Replace existing "{target.name}"</span>
                <span id="reimport-replace-hint" class="block text-xs text-muted">
                  {#if replaceDisabled}
                    Not available: {sync.blockedMessage}
                  {:else}
                    Its folders, requests, scripts and descriptions are replaced by the file. The collection keeps its versions,
                    sync and open tabs. A version snapshot of the current content (next patch version) is created first, so you
                    can restore it from Versions.
                  {/if}
                </span>
              </span>
            </label>
            {#if match.collections.length > 1 && choice === 'replace'}
              <label class="ml-7 flex flex-col gap-1 text-xs">
                <span class="font-medium">Collection to replace</span>
                <select class="rounded border border-border bg-raised px-2 py-1 text-sm" bind:value={targetId} data-testid="reimport-target">
                  {#each match.collections as c (c.id)}
                    <option value={c.id}>{describeTarget(c)}</option>
                  {/each}
                </select>
              </label>
            {/if}
            <label
              class="flex cursor-pointer items-start gap-2 rounded border p-2.5 focus-within:ring-2 focus-within:ring-focus {choice === 'copy' ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover'}"
            >
              <input type="radio" name="reimport-mode" value="copy" checked={choice === 'copy'} onchange={() => (mode = 'copy')} class="mt-1" />
              <span>
                <span class="block font-medium">Import as a copy named "{copyAs}"</span>
                <span class="block text-xs text-muted">The existing collection is left untouched.</span>
              </span>
            </label>
          </fieldset>
        {/if}
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
      <Button variant="primary" loading={busy} disabled={!parsed} onclick={submit}>
        {choice === 'replace' ? 'Replace' : choice === 'copy' ? 'Import as copy' : 'Import'}
      </Button>
    {/snippet}
  </Dialog>
{/if}
