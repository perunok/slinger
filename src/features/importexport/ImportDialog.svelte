<script lang="ts">
  /**
   * Import dialog: Slinger or Postman collections, environments and globals, from a file (drop / choose) or pasted JSON
   * (the paste area, Ctrl+V anywhere in the dialog, or JSON pasted into a request's URL bar, see UrlBar), and cURL commands
   * (added as requests to a collection the user picks; lib/curl.ts parses them, curlImport.ts places them).
   * Whichever was provided last is imported.
   */
  import { tick } from 'svelte'
  import { expandedStore } from '../../app/expanded.svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { formatBytes } from '../../lib/response'
  import { findEnvByName } from '../environments/envLogic'
  import { tabsStore } from '../requests/tabs.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import { mapRestored, remapExpandedKeys } from '../versions/restoreRemap'
  import { describeEnvImport, describeGlobalsImport, importIntoEnvironment, importIntoGlobals, planMerge, type ImportVar, type MergeMode } from './envImport'
  import type { VersionHistoryImportResult } from '../../../shared/slingerExport'
  import { IMPORT_FILE_ACCEPT } from './fileName'
  import { parsePostmanFile, type PostmanFile } from './parse'
  import { copyName, findReimportMatches } from './reimport'
  import { containsCurl, curlRequestName, parseCurl, type ParsedCurl } from '../../lib/curl'
  import { methodColor } from '../requests/method'
  import { addCurlRequests, defaultCurlTarget, folderChoices, NEW_COLLECTION_NAME, type CurlTarget } from './curlImport'

  interface Props {
    open: boolean
    onclose: () => void
    /** Collection/environment JSON pasted elsewhere (the URL bar): the dialog opens with it in the paste area. */
    initialText?: string | null
  }
  let { open, onclose, initialText = null }: Props = $props()

  /** Pastes larger than this are not put into the textarea (rendering megabytes there is slow): a chip stands in. */
  const LARGE_PASTE = 256 * 1024
  const PASTE_DEBOUNCE_MS = 300
  /** Label of the safety version's notes when a pasted collection replaces an existing one. */
  const PASTE_SOURCE_LABEL = 'pasted JSON'

  let fileName = $state<string | null>(null)
  /** Where `text` came from: the last file chosen/dropped or the last paste. */
  let source = $state<'file' | 'paste' | null>(null)
  let text = $state.raw('')
  /** Length of the pasted text (chars), for the size indicator. */
  let pasteSize = $state(0)
  /** The pasted text is too large for the textarea and is held outside it. */
  let pasteLarge = $state(false)
  /** Shown when the dialog was opened by pasting JSON into the URL bar. */
  let note = $state<string | null>(null)
  let pasteArea: HTMLTextAreaElement | undefined = $state()
  let pasteTimer: ReturnType<typeof setTimeout> | undefined
  let parsed = $state.raw<PostmanFile | null>(null)
  let error = $state<string | null>(null)
  /** Also copy the collection's variables into an environment (off: they are stored as collection variables). */
  let makeEnv = $state(false)
  let busy = $state(false)
  let dragging = $state(false)
  let input: HTMLInputElement | undefined = $state()
  /** Re-import of an existing collection: replace it (default) or import as a copy. */
  let mode = $state<'replace' | 'copy'>('replace')
  let targetId = $state<string | null>(null)
  /** cURL commands to add as requests (instead of `parsed`), their names and where they go. */
  let curl = $state.raw<ParsedCurl[] | null>(null)
  let curlNames = $state<string[]>([])
  let curlTarget = $state<CurlTarget>({ collectionId: null, newName: NEW_COLLECTION_NAME, folderId: null })
  const curlFolders = $derived(curlTarget.collectionId ? folderChoices(app.foldersOf(curlTarget.collectionId)) : [])

  /** Parses `t` as a cURL command (text that is not JSON and has `curl` in it) or an export. */
  function parseText(t: string) {
    parsed = null
    curl = null
    if (!t.trimStart().startsWith('{') && containsCurl(t)) {
      const r = parseCurl(t)
      if (!r.ok) {
        error = r.error
        return
      }
      curl = r.requests
      curlNames = r.requests.map((p) => curlRequestName(p))
      const activeId = tabsStore.active?.requestId ?? null
      curlTarget = defaultCurlTarget(app.collections, activeId ? (app.requests.find((x) => x.id === activeId) ?? null) : null)
      return
    }
    const r = parsePostmanFile(t)
    if (r.ok) parsed = r.file
    else error = r.error
  }

  $effect(() => {
    if (!open) {
      clearTimeout(pasteTimer)
      fileName = null
      source = null
      text = ''
      pasteSize = 0
      pasteLarge = false
      note = null
      parsed = null
      error = null
      makeEnv = false
      busy = false
      dragging = false
      mode = 'replace'
      targetId = null
      curl = null
      curlNames = []
      return
    }
    const t = initialText
    if (t) {
      void tick().then(() => {
        putPaste(t)
        note = curl
          ? `Detected pasted cURL command${curl.length === 1 ? '' : 's'} — choose where to add ${curl.length === 1 ? 'it' : 'them'}`
          : `Detected pasted ${parsed?.kind === 'environment' ? 'environment' : parsed?.kind === 'globals' ? 'globals' : 'collection'} — review and import`
      })
    }
  })

  /** Parses `t` as the import source (a paste); replaces a chosen file. */
  function usePasted(t: string) {
    clearTimeout(pasteTimer)
    if (source === 'file' && input) input.value = ''
    fileName = null
    note = null
    pasteSize = t.length
    if (t.trim() === '') {
      if (source === 'paste') {
        source = null
        text = ''
        parsed = null
        curl = null
        error = null
      }
      return
    }
    source = 'paste'
    text = t
    error = null
    parseText(t)
    mode = 'replace'
    targetId = null
  }

  /** Puts pasted text into the paste area (or the large-paste chip) and parses it right away. */
  function putPaste(t: string) {
    pasteLarge = t.length > LARGE_PASTE
    if (pasteArea) pasteArea.value = pasteLarge ? '' : t
    usePasted(t)
  }

  function onAreaPaste(e: ClipboardEvent) {
    const t = e.clipboardData?.getData('text/plain') ?? ''
    if (t.length > LARGE_PASTE) {
      e.preventDefault()
      putPaste(t)
      return
    }
    // Small pastes go into the textarea as usual; parse as soon as the value has been updated.
    clearTimeout(pasteTimer)
    pasteTimer = setTimeout(() => usePasted(pasteArea?.value ?? ''), 0)
  }

  /** Typing/editing in the paste area: parse once the user stops for a moment (never per keystroke). */
  function onAreaInput() {
    clearTimeout(pasteTimer)
    pasteTimer = setTimeout(() => usePasted(pasteArea?.value ?? ''), PASTE_DEBOUNCE_MS)
  }

  function flushArea() {
    if (pasteLarge || pasteTimer === undefined) return
    clearTimeout(pasteTimer)
    pasteTimer = undefined
    const v = pasteArea?.value ?? ''
    if (v !== (source === 'paste' ? text : '')) usePasted(v)
  }

  function clearPaste() {
    pasteLarge = false
    if (pasteArea) {
      pasteArea.value = ''
      pasteArea.focus()
    }
    usePasted('')
  }

  const isTextField = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)))

  // Ctrl+V while the dialog is open and focus is not in a text field pastes into the paste area.
  $effect(() => {
    if (!open) return
    const onpaste = (e: ClipboardEvent) => {
      if (busy || isTextField(e.target) || isTextField(document.activeElement)) return
      const t = e.clipboardData?.getData('text/plain') ?? ''
      if (!t.trim()) return
      e.preventDefault()
      putPaste(t)
    }
    document.addEventListener('paste', onpaste)
    return () => document.removeEventListener('paste', onpaste)
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
    clearTimeout(pasteTimer)
    source = 'file'
    fileName = file.name
    note = null
    pasteSize = 0
    pasteLarge = false
    if (pasteArea) pasteArea.value = ''
    parsed = null
    curl = null
    error = null
    try {
      text = await readText(file)
    } catch (e) {
      text = ''
      error = `Could not read the file: ${errorInfo(e).message}`
      return
    }
    parseText(text)
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
  /** "file" or "pasted JSON", for wording that applies to both. */
  const what = $derived(source === 'paste' ? 'pasted JSON' : 'file')
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
  async function replaceExisting(collectionId: string, name: string): Promise<{ summary: [string, string]; history?: VersionHistoryImportResult }> {
    const before = { folders: app.foldersOf(collectionId).slice(), requests: app.requestsOf(collectionId).slice() }
    const result = await api().replaceCollectionFromPostman(collectionId, text, source === 'paste' ? PASTE_SOURCE_LABEL : fileName)
    const map = mapRestored(before, { folders: result.folders, requests: result.requests })
    expandedStore.replace(remapExpandedKeys(expandedStore.keys, map.folders, new Set(before.folders.map((f) => f.id))))
    tabsStore.followReplaced(map.requests)
    await app.reloadCollections()
    const n = result.requests.length
    return {
      summary: [
        'Collection replaced',
        `"${name}" now has ${n} request${n === 1 ? '' : 's'}. The previous content was saved as version ${result.safetyVersion.version}.`,
      ],
      history: result.versionHistory,
    }
  }

  /** Adds the cURL commands as requests where the user chose, then opens the first one. */
  async function submitCurl(list: ParsedCurl[]) {
    const ws = app.workspaceId
    if (!ws || busy) return
    busy = true
    error = null
    try {
      const target = { ...curlTarget }
      const { collectionId, created } = await addCurlRequests(
        ws,
        list.map((p, i) => ({ parsed: p, name: curlNames[i]?.trim() || curlRequestName(p) })),
        target,
      )
      await app.reloadCollections()
      expandedStore.set(`collection:${collectionId}`, true)
      if (target.collectionId && target.folderId) expandedStore.set(`folder:${target.folderId}`, true)
      if (created[0]) tabsStore.openRequest(created[0])
      const collectionName = app.collections.find((c) => c.id === collectionId)?.name ?? target.newName
      const n = created.length
      toast.success(n === 1 ? 'Request added' : `${n} requests added`, `${n === 1 ? `"${created[0]!.name}"` : `${n} requests`} in "${collectionName}"`)
      onclose()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }

  async function submit() {
    if (curl) return submitCurl(curl)
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
      if (file.kind === 'globals') {
        try {
          toast.success('Globals imported', describeGlobalsImport(await importIntoGlobals(api(), ws, file.variables)))
        } finally {
          await app.reloadGlobals()
        }
        onclose()
        return
      }
      let summary: [string, string]
      // The file's `info._slinger` version history, when it had one (restored by both import and replace).
      let history: VersionHistoryImportResult | undefined
      if (choice === 'replace' && target) {
        ;({ summary, history } = await replaceExisting(target.id, target.name))
      } else {
        const result = choice === 'copy' ? await api().importPostmanCollection(ws, text, { name: copyAs }) : await api().importPostmanCollection(ws, text)
        await app.reloadCollections()
        history = result.versionHistory
        const scripts = result.scriptCount ?? 0
        const vars = result.variableCount ?? 0
        summary = [
          'Collection imported',
          `${result.collection.name}: ${result.requests.length} request${result.requests.length === 1 ? '' : 's'}${scripts ? `, ${scripts} script${scripts === 1 ? '' : 's'}` : ''}${vars ? `, ${vars} collection variable${vars === 1 ? '' : 's'}` : ''}`,
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
      if (history) {
        const h = history
        const restored = `${h.restored} version${h.restored === 1 ? '' : 's'} restored`
        if (h.notes.length > 0) toast.info(`Version history: ${restored}`, h.notes.join(' '))
        else toast.success('Version history restored', restored)
      }
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
  <Dialog title="Import" {onclose} {busy} size="md">
    <div class="flex flex-col gap-3 text-sm">
      <p class="-mt-1 text-xs text-muted" data-testid="import-subtitle">Slinger or Postman collections, environments and globals (JSON), or cURL commands</p>
      {#if note}
        <p class="rounded border border-accent bg-accent-soft px-2 py-1.5 text-xs" role="status" data-testid="import-note">{note}</p>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex flex-col items-center gap-2 rounded border border-dashed px-4 py-4 text-center {dragging ? 'border-accent bg-accent-soft' : 'border-border bg-raised'} {source === 'file' ? 'ring-1 ring-accent' : ''}"
        ondragover={(e) => {
          e.preventDefault()
          dragging = true
        }}
        ondragleave={() => (dragging = false)}
        {ondrop}
      >
        <p class="text-muted">Drop a collection or environment .json here (Slinger export or Postman v2.x)</p>
        <input
          bind:this={input}
          id="pm-file"
          type="file"
          accept={IMPORT_FILE_ACCEPT}
          class="sr-only"
          aria-label="Import file"
          onchange={(e) => load(e.currentTarget.files?.[0])}
        />
        <Button onclick={() => input?.click()} disabled={busy}>Choose file</Button>
        {#if fileName}<p class="text-xs text-muted" data-testid="import-file-name">{fileName}</p>{/if}
      </div>

      <div class="flex flex-col gap-1">
        <div class="flex items-baseline justify-between gap-2">
          <label for="import-paste" class="text-xs font-medium">Or paste JSON or a cURL command</label>
          {#if source === 'paste' && pasteSize > 0}
            <span class="text-xs text-muted" data-testid="import-paste-size">{formatBytes(pasteSize)} pasted</span>
          {/if}
        </div>
        {#if pasteLarge}
          <div class="flex items-center justify-between gap-2 rounded border border-border bg-raised px-2 py-1.5 text-xs {source === 'paste' ? 'ring-1 ring-accent' : ''}" data-testid="import-paste-large">
            <span>Pasted JSON ({formatBytes(pasteSize)}), too large to show here.</span>
            <Button size="sm" onclick={clearPaste} disabled={busy}>Clear</Button>
          </div>
        {/if}
        <textarea
          bind:this={pasteArea}
          id="import-paste"
          rows="4"
          spellcheck="false"
          autocomplete="off"
          hidden={pasteLarge}
          disabled={busy}
          class="w-full resize-y rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs {source === 'paste' ? 'ring-1 ring-accent' : ''}"
          placeholder={'Paste an exported collection or environment ({"info": {…}, "item": […]}), or one or more cURL commands (curl https://…). Ctrl+V anywhere in this dialog works too.'}
          onpaste={onAreaPaste}
          oninput={onAreaInput}
          onblur={flushArea}
        ></textarea>
      </div>

      <InlineError message={error} />

      {#if curl}
        {@render curlPreview(curl)}
      {:else if parsed?.kind === 'collection'}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
          <dt class="text-muted">Format</dt><dd data-testid="import-source">{parsed.source}</dd>
          <dt class="text-muted">Collection</dt><dd class="font-medium">{parsed.name}</dd>
          <dt class="text-muted">Folders</dt><dd>{parsed.folders}</dd>
          <dt class="text-muted">Requests</dt><dd>{parsed.requests}</dd>
          <dt class="text-muted">Saved examples</dt><dd data-testid="import-examples">{parsed.examples}</dd>
          <dt class="text-muted">Scripts</dt><dd data-testid="import-scripts">{parsed.scripts > 0 ? `${parsed.scripts} (pre-request and test, all levels)` : 'none'}</dd>
          <dt class="text-muted">Collection variables</dt>
          <dd data-testid="import-variables">
            {#if (parsed.collectionVariables?.total ?? 0) > 0}
              {parsed.collectionVariables!.total} stored with the collection{parsed.collectionVariables!.disabled ? ` (${parsed.collectionVariables!.disabled} disabled)` : ''}
            {:else}none{/if}
          </dd>
          {#if parsed.history}
            <dt class="text-muted">Version history</dt>
            <dd data-testid="import-history">
              {parsed.history.versions} version{parsed.history.versions === 1 ? '' : 's'}{parsed.history.latest ? `, latest v${parsed.history.latest}` : ''}{parsed.history.versions > 0 && !parsed.history.snapshots ? ' (list only, no snapshots: not restorable)' : ''}
            </dd>
          {/if}
        </dl>
        {#if match && target}
          <fieldset class="flex flex-col gap-2" disabled={busy} data-testid="reimport-choice">
            <legend class="mb-1 text-xs font-medium">
              {match.collections.length === 1
                ? `This collection already exists in the workspace${match.by === 'id' ? '' : ' (same name)'}.`
                : `${match.collections.length} collections in the workspace match this ${what}${match.by === 'id' ? '' : ' by name'}.`}
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
                    Its folders, requests, scripts, descriptions and collection variables are replaced by the {what}. The collection keeps its versions,
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
              Also copy the collection variables into environment "{parsed.name}"
              <span class="block text-xs text-muted" data-testid="import-env-help">
                Not needed for {'{{'}placeholders{'}}'} to work: the variables are stored with the collection. Use this to share them with
                other collections or to override them per environment.
                {#if existingEnv}
                  {#if newVarCount === null}
                    Adds the missing variables to the existing environment "{existingEnv.name}"; existing values are kept.
                  {:else}
                    Adds {newVarCount} new variable{newVarCount === 1 ? '' : 's'} to the existing environment "{existingEnv.name}"; existing
                    values are kept.
                  {/if}
                {:else}
                  Creates an environment named "{parsed.name}" with {parsed.variables.length} variable{parsed.variables.length === 1 ? '' : 's'}.
                {/if}
              </span>
            </span>
          </label>
        {:else}
          <p class="text-xs text-muted">The collection has no collection-level variables.</p>
        {/if}
      {:else if parsed?.kind === 'globals'}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
          <dt class="text-muted">Format</dt><dd data-testid="import-source">{parsed.source}</dd>
          <dt class="text-muted">Variables</dt>
          <dd>
            {parsed.variables.length} ({parsed.variables.filter((v) => v.secret).length} secret{parsed.variables.some((v) => v.enabled === false)
              ? `, ${parsed.variables.filter((v) => v.enabled === false).length} disabled`
              : ''})
          </dd>
        </dl>
        <p class="text-xs text-muted" data-testid="import-globals-help">
          Imported into this workspace's Globals: missing variables are added and existing ones take the values from this {what}.
          Empty values in the {what} keep the current value.
        </p>
      {:else if parsed?.kind === 'environment'}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
          <dt class="text-muted">Format</dt><dd data-testid="import-source">{parsed.source}</dd>
          <dt class="text-muted">Environment</dt><dd class="font-medium">{parsed.name}</dd>
          <dt class="text-muted">Variables</dt><dd>{parsed.variables.length} ({parsed.variables.filter((v) => v.secret).length} secret)</dd>
        </dl>
        {#if existingEnv}
          <p class="text-xs text-muted" data-testid="import-env-help">
            An environment named "{existingEnv.name}" already exists: missing variables are added and
            existing ones take the values from this {what}. Empty values in the {what} keep the current value.
          </p>
        {/if}
        {#if parsed.skippedDisabled > 0}
          <p class="text-xs text-muted">{parsed.skippedDisabled} disabled variable{parsed.skippedDisabled === 1 ? ' is' : 's are'} skipped.</p>
        {/if}
      {/if}
    </div>
    {#snippet footer()}
      <Button onclick={onclose} disabled={busy}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={curl ? sync.blocked : !parsed} onclick={submit}>
        {curl ? (curl.length === 1 ? 'Add request' : `Add ${curl.length} requests`) : choice === 'replace' ? 'Replace' : choice === 'copy' ? 'Import as copy' : 'Import'}
      </Button>
    {/snippet}
  </Dialog>
{/if}

{#snippet curlPreview(list: ParsedCurl[])}
  <section class="flex flex-col gap-3" aria-label="cURL import" data-testid="curl-preview">
    <ul class="flex max-h-72 flex-col gap-2 overflow-auto">
      {#each list as p, i (i)}
        <li class="rounded border border-border p-2" data-testid="curl-request">
          <div class="flex min-w-0 items-center gap-2">
            <span class="w-16 shrink-0 font-mono text-xs font-semibold" style="color:{methodColor(p.method)}">{p.method}</span>
            <span class="min-w-0 truncate font-mono text-xs" title={p.url}>{p.url}</span>
          </div>
          <label class="mt-1.5 flex items-center gap-2 text-xs">
            <span class="w-12 shrink-0 text-muted">Name</span>
            <input class="min-w-0 flex-1" bind:value={curlNames[i]} aria-label={list.length === 1 ? 'Request name' : `Name of request ${i + 1}`} disabled={busy} />
          </label>
          <p class="mt-1 text-xs text-muted" data-testid="curl-summary">
            {[
              `${p.headers.length} header${p.headers.length === 1 ? '' : 's'}`,
              p.body.kind === 'none' ? 'no body' : p.body.kind === 'raw' ? `${p.body.rawLanguage.toUpperCase()} body` : p.body.kind === 'urlEncoded' ? 'form body (url-encoded)' : p.body.kind === 'formData' ? 'form-data body' : 'file body',
              p.auth ? `${p.auth.kind === 'basic' ? 'Basic' : 'Bearer'} auth` : null,
              p.timeoutMs ? `timeout ${p.timeoutMs / 1000} s` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {#if p.warnings.length > 0}
            <ul class="mt-1 list-disc pl-4 text-xs text-warning" data-testid="curl-warnings">
              {#each p.warnings as w (w)}<li>{w}</li>{/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
    <div class="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2 text-xs">
      <label for="curl-collection" class="text-muted">Collection</label>
      <select
        id="curl-collection"
        value={curlTarget.collectionId ?? ''}
        disabled={busy}
        onchange={(e) => (curlTarget = { ...curlTarget, collectionId: e.currentTarget.value || null, folderId: null })}
      >
        {#each app.collections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
        <option value="">New collection…</option>
      </select>
      {#if curlTarget.collectionId === null}
        <label for="curl-new-collection" class="text-muted">New collection name</label>
        <input id="curl-new-collection" bind:value={curlTarget.newName} disabled={busy} />
      {:else if curlFolders.length > 0}
        <label for="curl-folder" class="text-muted">Folder</label>
        <select id="curl-folder" value={curlTarget.folderId ?? ''} disabled={busy} onchange={(e) => (curlTarget = { ...curlTarget, folderId: e.currentTarget.value || null })}>
          <option value="">(top level)</option>
          {#each curlFolders as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
        </select>
      {/if}
    </div>
    {#if sync.blocked}
      <p class="text-xs text-muted">Not available: {sync.blockedMessage}</p>
    {/if}
  </section>
{/snippet}
