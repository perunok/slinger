<script lang="ts">
  /**
   * The OpenAPI dialog of a collection (collection menu > OpenAPI…): the document it is linked to, "Update from source"
   * (review what changed, choose per operation, apply after a safety version), "Link a spec…", Unlink, and Export.
   */
  import type { OpenApiFolderMode, OpenApiLink, OpenApiSource, OpenApiUpdatePlan, OpenApiUpdateResult } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { sync } from '../sync/syncStore.svelte'
  import { invalidateOpenApiLink } from './openapiStore.svelte'
  import { applySummary, defaultChoices, reviewGroups, sourceLabel, unchangedCount, type Choice } from './review'

  const collectionId = $derived(ui.openApiFor)
  const collection = $derived(app.collections.find((c) => c.id === collectionId) ?? null)
  const readOnly = $derived(sync.blocked)

  type View = 'info' | 'source' | 'review' | 'result'
  let view = $state<View>('info')
  /** undefined while loading. */
  let link = $state<OpenApiLink | null | undefined>(undefined)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let stale = $state(false)
  let confirmUnlink = $state(false)

  // Source form (update from another document, or link one).
  let purpose = $state<'update' | 'link'>('update')
  let sourceKind = $state<'url' | 'file' | 'text'>('url')
  let url = $state('')
  let pasted = $state('')
  let file = $state<{ name: string; text: string } | null>(null)
  let folders = $state<OpenApiFolderMode>('tags')
  let fileInput = $state<HTMLInputElement | null>(null)

  let plan = $state.raw<OpenApiUpdatePlan | null>(null)
  let choices = $state<Record<string, Choice>>({})
  let lastRequest: Parameters<ReturnType<typeof api>['planOpenApiUpdate']>[0] | null = null
  let result = $state.raw<OpenApiUpdateResult | null>(null)

  $effect(() => {
    const id = collectionId
    link = undefined
    view = 'info'
    error = null
    if (!id) return
    let gone = false
    api()
      .getOpenApiLink(id)
      .then((l) => {
        if (!gone) link = l
      })
      .catch((e) => {
        if (!gone) {
          link = null
          error = errorInfo(e).message
        }
      })
    return () => {
      gone = true
    }
  })

  function close() {
    ui.openApiFor = null
  }

  async function run(fn: () => Promise<void>) {
    busy = true
    error = null
    stale = false
    try {
      await fn()
    } catch (e) {
      const info = errorInfo(e)
      error = info.message
      stale = info.code === 'invalid_input' && /review the update again/.test(info.message)
    } finally {
      busy = false
    }
  }

  async function review(input: NonNullable<typeof lastRequest>) {
    lastRequest = input
    const p = await api().planOpenApiUpdate(input)
    plan = p
    choices = defaultChoices(p)
    view = 'review'
  }

  /** Update from source: a linked URL is fetched again; a pasted or file document is asked for. */
  function updateFromSource() {
    if (!collection) return
    if (link?.sourceKind === 'url') return run(() => review({ collectionId: collection.id }))
    openSource('update')
  }

  function openSource(p: 'update' | 'link') {
    purpose = p
    sourceKind = link?.sourceKind === 'file' ? 'file' : link?.sourceKind === 'text' ? 'text' : 'url'
    url = link?.sourceKind === 'url' ? (link.source ?? '') : ''
    folders = link?.folders ?? 'tags'
    error = null
    view = 'source'
  }

  async function chooseFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      const text =
        typeof f.text === 'function'
          ? await f.text()
          : await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result ?? ''))
              reader.onerror = () => reject(reader.error ?? new Error('read failed'))
              reader.readAsText(f)
            })
      file = { name: f.name, text }
      error = null
    } catch (err) {
      error = `Could not read ${f.name}: ${errorInfo(err).message}`
    }
  }

  const sourceReady = $derived(sourceKind === 'url' ? url.trim() !== '' : sourceKind === 'file' ? file !== null : pasted.trim() !== '')

  function submitSource() {
    if (!collection || !sourceReady) return
    const id = collection.id
    return run(async () => {
      if (purpose === 'update') {
        if (sourceKind === 'url') await review({ collectionId: id, url: url.trim() })
        else if (sourceKind === 'file') await review({ collectionId: id, text: file!.text, source: { kind: 'file', value: file!.name } })
        else await review({ collectionId: id, text: pasted, source: { kind: 'text', value: null } })
        return
      }
      // Link: store the document first (main fetches a URL), then review what matching it would change.
      let text = sourceKind === 'file' ? file!.text : pasted
      let source: OpenApiSource = sourceKind === 'file' ? { kind: 'file', value: file!.name } : { kind: 'text', value: null }
      if (sourceKind === 'url') {
        text = (await api().previewOpenApi({ url: url.trim() })).text
        source = { kind: 'url', value: url.trim() }
      }
      link = await api().linkOpenApi({ collectionId: id, text, source, folders })
      invalidateOpenApiLink(id)
      await review({ collectionId: id, text, source })
    })
  }

  function apply() {
    if (!collection || !plan) return
    const p = plan
    return run(async () => {
      result = await api().applyOpenApiUpdate({ collectionId: p.collectionId, planId: p.planId, choices: { ...choices } })
      link = result.link
      invalidateOpenApiLink(p.collectionId)
      view = 'result'
      await Promise.all([app.reloadCollections(), app.reloadCollectionVariables(p.collectionId)])
    })
  }

  function reviewAgain() {
    if (lastRequest) {
      const input = lastRequest
      return run(() => review(input))
    }
  }

  async function unlink() {
    if (!collection) return
    await api().unlinkOpenApi(collection.id)
    invalidateOpenApiLink(collection.id)
    link = null
    view = 'info'
  }

  function exportOpenApi() {
    const id = collectionId
    close()
    ui.exportCollectionId = id
  }

  const groups = $derived(plan ? reviewGroups(plan) : [])
  const when = (s: number) => new Date(s * 1000).toLocaleString()
  const folderLabels: Record<OpenApiFolderMode, string> = { tags: 'By tag', paths: 'By path', none: 'None' }
</script>

{#if collection}
  <Dialog title="OpenAPI: {collection.name}" onclose={close} {busy} size="lg">
    <div class="flex flex-col gap-3 text-sm" data-testid="openapi-dialog">
      <InlineError message={error} />
      {#if stale}
        <div><Button size="sm" icon="refresh" onclick={reviewAgain} disabled={busy}>Review again</Button></div>
      {/if}

      {#if view === 'info'}
        {#if link === undefined}
          <p class="flex items-center gap-2 text-xs text-muted"><Spinner /> Loading…</p>
        {:else if link}
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" data-testid="openapi-link">
            <dt class="text-muted">Document</dt><dd class="font-medium">{link.title}</dd>
            <dt class="text-muted">Version</dt><dd>{link.specVersion || '—'}</dd>
            <dt class="text-muted">Format</dt><dd>{link.oasVersion === '2.0' ? 'Swagger 2.0' : `OpenAPI ${link.oasVersion}`}</dd>
            <dt class="text-muted">Source</dt><dd class="break-all">{sourceLabel(link.sourceKind, link.source)}</dd>
            <dt class="text-muted">Operations</dt><dd>{link.operationCount}</dd>
            <dt class="text-muted">Folders</dt><dd>{folderLabels[link.folders]}</dd>
            <dt class="text-muted">Imported</dt><dd>{when(link.importedAt)}</dd>
            {#if link.updatedAt !== link.importedAt}<dt class="text-muted">Updated</dt><dd>{when(link.updatedAt)}</dd>{/if}
          </dl>
          <p class="text-xs text-muted">The link is kept on this device only; requests remember their operation, so another device can link the same document again.</p>
        {:else}
          <p>This collection is not linked to an OpenAPI document.</p>
          <p class="flex items-center gap-1.5 text-xs text-muted">
            Link one to check responses against it and to update the collection when the document changes.
            <InfoTip label="About linking a document">
              <span>Linking changes no request. The review that follows matches the collection's requests to the document's operations: by the operation they were imported from, else by method and path (<code>{'{{baseUrl}}'}/pets/:id</code> matches <code>GET /pets/{'{petId}'}</code>).</span>
              <span>Operations without a request are offered as additions; matched requests that differ from the document are kept unless you choose "Take spec".</span>
            </InfoTip>
          </p>
        {/if}
      {:else if view === 'source'}
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 font-medium">{purpose === 'link' ? 'Document to link' : 'New version of the document'}</legend>
          <div class="flex gap-4" role="radiogroup" aria-label="Where the document comes from">
            <label class="flex items-center gap-1.5"><input type="radio" name="openapi-source" value="url" bind:group={sourceKind} /> From URL</label>
            <label class="flex items-center gap-1.5"><input type="radio" name="openapi-source" value="file" bind:group={sourceKind} /> From a file</label>
            <label class="flex items-center gap-1.5"><input type="radio" name="openapi-source" value="text" bind:group={sourceKind} /> Paste</label>
          </div>
          {#if sourceKind === 'url'}
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted">URL (fetched by Slinger, not by this window)</span>
              <input type="url" bind:value={url} placeholder="https://api.example.com/openapi.yaml" class="rounded border border-border bg-surface px-2 py-1" />
            </label>
          {:else if sourceKind === 'file'}
            <div class="flex items-center gap-2">
              <Button icon="file" onclick={() => fileInput?.click()}>Choose file…</Button>
              <span class="truncate text-xs text-muted" data-testid="openapi-file">{file ? file.name : 'JSON or YAML (.json, .yaml, .yml)'}</span>
              <input bind:this={fileInput} type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" class="hidden" aria-label="OpenAPI file" onchange={chooseFile} />
            </div>
          {:else}
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted">OpenAPI 3.x or Swagger 2.0, JSON or YAML</span>
              <textarea bind:value={pasted} rows="10" class="resize-y rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs" aria-label="Document text"></textarea>
            </label>
          {/if}
          {#if purpose === 'link'}
            <label class="flex items-center gap-2">
              <span class="text-xs text-muted">Folders for added requests</span>
              <select bind:value={folders}>
                {#each Object.entries(folderLabels) as [id, label] (id)}<option value={id}>{label}</option>{/each}
              </select>
            </label>
          {/if}
        </fieldset>
      {:else if view === 'review' && plan}
        <div class="flex items-center gap-1.5">
          <p>
            <span class="font-medium">{plan.title}</span>
            {#if plan.previousSpecVersion && plan.previousSpecVersion !== plan.specVersion}
              <span class="text-muted">v{plan.previousSpecVersion} → v{plan.specVersion}</span>
            {:else}
              <span class="text-muted">v{plan.specVersion}</span>
            {/if}
          </p>
          <InfoTip label="How updates work">
            <span>Each operation in the document is compared with the collection's request for it. "Changed" requests were not edited here since the import: updating them is safe. "Changed here and in the spec" requests were edited here too: they are kept unless you take the spec's version.</span>
            <span>An update replaces only what the document defines: method, URL and query parameters, headers, body, generated examples, and auth and description while they are still the generated ones. Your own headers, query parameters, examples, scripts, name, folder and position are kept.</span>
            <span>Apply first saves a version of the collection (restore it under Versions… to undo), then links the collection to this document.</span>
          </InfoTip>
        </div>
        {#if plan.notes.length}
          <ul class="list-inside list-disc text-xs" aria-label="Collection changes" data-testid="openapi-notes">
            {#each plan.notes as note (note)}<li>{note}</li>{/each}
          </ul>
        {/if}
        {#if plan.warnings.length}
          <ul class="list-inside list-disc text-xs text-warning" aria-label="Warnings">
            {#each plan.warnings as w (w)}<li>{w}</li>{/each}
          </ul>
        {/if}
        {#if groups.length === 0}
          <p class="text-muted" data-testid="openapi-up-to-date">The requests already match the document.</p>
        {/if}
        {#each groups as g (g.id)}
          <section aria-labelledby="openapi-group-{g.id}" class="rounded border border-border">
            <header class="border-b border-border bg-raised px-2 py-1.5">
              <h3 id="openapi-group-{g.id}" class="text-xs font-semibold">{g.title} ({g.changes.length})</h3>
              <p class="text-xs text-muted">{g.hint}</p>
            </header>
            <ul>
              {#each g.changes as c (c.key)}
                <li class="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0">
                  <div class="min-w-0 flex-1">
                    <p class="truncate">{c.name}</p>
                    <p class="truncate text-xs text-muted">
                      <span class="font-mono">{c.key}</span>{#if c.summary} · {c.summary}{/if}{#if g.id === 'added' && c.folder} · folder {c.folder}{/if}
                    </p>
                  </div>
                  <select aria-label="Choice for {c.key}" bind:value={choices[c.key]} disabled={busy}>
                    {#each g.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                  </select>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
        <p class="text-xs text-muted" data-testid="openapi-apply-summary">
          {applySummary(plan, choices)}{unchangedCount(plan) ? `; ${unchangedCount(plan)} unchanged` : ''}.
          {#if readOnly}This workspace is read-only: the update cannot be applied.{/if}
        </p>
      {:else if view === 'result' && result}
        <div role="status" data-testid="openapi-result">
          <p class="font-medium">Collection updated from {result.link.title} v{result.link.specVersion}</p>
          <p>{result.added} added, {result.updated} updated, {result.deleted} deleted, {result.kept} kept.</p>
          {#if result.safetyVersion}
            <p class="text-xs text-muted">The previous content was saved as version {result.safetyVersion.version}: restore it under Versions… to undo.</p>
          {/if}
        </div>
      {/if}
    </div>

    {#snippet footer()}
      {#if view === 'info'}
        <Button class="mr-auto" icon="download" onclick={exportOpenApi} disabled={busy}>Export as OpenAPI…</Button>
        {#if link}
          <Button variant="ghost" icon="trash" onclick={() => (confirmUnlink = true)} disabled={busy}>Unlink</Button>
          {#if link.sourceKind === 'url'}<Button onclick={() => openSource('update')} disabled={busy}>Use another document…</Button>{/if}
          <Button variant="primary" icon="refresh" loading={busy} onclick={updateFromSource}>Update from source</Button>
        {:else if link === null}
          <Button variant="primary" icon="link" onclick={() => openSource('link')} disabled={busy}>Link a spec…</Button>
        {/if}
      {:else if view === 'source'}
        <Button onclick={() => (view = 'info')} disabled={busy}>Back</Button>
        <Button variant="primary" loading={busy} disabled={!sourceReady} onclick={submitSource}>{purpose === 'link' ? 'Link and review' : 'Review changes'}</Button>
      {:else if view === 'review'}
        <Button onclick={() => (view = 'info')} disabled={busy}>Back</Button>
        <Button variant="primary" loading={busy} disabled={readOnly} onclick={apply}>Apply</Button>
      {:else}
        <Button variant="primary" onclick={close}>Close</Button>
      {/if}
    {/snippet}
  </Dialog>
  {#if confirmUnlink}
    <ConfirmDialog
      title="Unlink the document?"
      message={'The collection keeps its requests. Responses are no longer checked against the document and it can no longer be updated from it, until you link a document again.'}
      confirmLabel="Unlink"
      danger
      onconfirm={unlink}
      oncancel={() => (confirmUnlink = false)}
    />
  {/if}
{/if}
