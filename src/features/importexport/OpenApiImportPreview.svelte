<script lang="ts">
  /** What an OpenAPI/Swagger document will become, with the import options (folders, collection name). Part of the Import dialog. */
  import type { OpenApiFolderMode, OpenApiPreview } from '../../../shared/types'
  import InfoTip from '../../components/ui/InfoTip.svelte'

  interface Props {
    preview: OpenApiPreview
    folders: OpenApiFolderMode
    name: string
    /** A collection of this workspace already has the document's title. */
    existingName: string | null
    disabled: boolean
    onfolders: (mode: OpenApiFolderMode) => void
    onname: (name: string) => void
  }
  let { preview, folders, name, existingName, disabled, onfolders, onname }: Props = $props()

  const format = $derived(preview.oasVersion === '2.0' ? 'Swagger 2.0' : `OpenAPI ${preview.oasVersion}`)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const folderCount = $derived(folders === 'tags' ? preview.tags.length : folders === 'none' ? 0 : null)
</script>

<section class="flex flex-col gap-3" aria-label="OpenAPI import" data-testid="openapi-preview">
  <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-border p-3" aria-label="Import preview">
    <dt class="text-muted">Format</dt><dd data-testid="import-source">{format}</dd>
    <dt class="text-muted">API</dt>
    <dd class="font-medium">{preview.title}{preview.specVersion ? ` · version ${preview.specVersion}` : ''}</dd>
    <dt class="text-muted">Operations</dt><dd data-testid="openapi-operations">{plural(preview.operationCount, 'request')}, each with saved examples for its documented responses</dd>
    {#if preview.tags.length > 0}
      <dt class="text-muted">Tags</dt>
      <dd class="min-w-0" data-testid="openapi-tags">
        {preview.tags.map((t) => `${t.name} (${t.count})`).join(', ')}{preview.untaggedCount ? `, ${preview.untaggedCount} untagged` : ''}
      </dd>
    {/if}
    <dt class="text-muted">Server</dt>
    <dd class="min-w-0 truncate font-mono text-xs" title={preview.servers.join('\n')}>
      {preview.servers[0] ?? 'none (set baseUrl after importing)'}{preview.servers.length > 1 ? ` (+${preview.servers.length - 1} more)` : ''}
    </dd>
    {#if preview.securitySchemes.length > 0}
      <dt class="text-muted">Auth</dt><dd>{preview.securitySchemes.join(', ')}</dd>
    {/if}
  </dl>

  {#if preview.warnings.length > 0}
    <ul class="list-disc rounded border border-warning bg-warning-soft py-1.5 pl-6 pr-2 text-xs" data-testid="openapi-warnings">
      {#each preview.warnings.slice(0, 8) as w (w)}<li>{w}</li>{/each}
      {#if preview.warnings.length > 8}<li>… and {preview.warnings.length - 8} more</li>{/if}
    </ul>
  {/if}

  <div class="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2 text-xs">
    <label for="openapi-folders" class="text-muted">Folders</label>
    <span class="flex items-center gap-2">
      <select id="openapi-folders" value={folders} {disabled} onchange={(e) => onfolders(e.currentTarget.value as OpenApiFolderMode)}>
        <option value="tags">By tag{preview.tags.length ? ` (${preview.tags.length})` : ''}</option>
        <option value="paths">By first path segment</option>
        <option value="none">None (all requests at the top)</option>
      </select>
      {#if folderCount !== null}<span class="text-muted">{folderCount === 0 ? 'no folders' : plural(folderCount, 'folder')}</span>{/if}
    </span>
    <label for="openapi-name" class="text-muted">Collection name</label>
    <input id="openapi-name" value={name} {disabled} oninput={(e) => onname(e.currentTarget.value)} />
  </div>
  {#if existingName}
    <p class="text-xs text-muted" data-testid="openapi-existing">
      A collection named "{existingName}" already exists. To bring it up to date with this document instead, use
      <strong>OpenAPI…</strong> in its menu.
    </p>
  {/if}
  <p class="flex items-center gap-1 text-xs text-muted">
    Requests use <code>{'{{baseUrl}}'}</code> and the auth variables, stored as collection variables.
    <InfoTip label="About importing OpenAPI">
      <span>Each operation becomes a request with its path, query and header parameters, body and auth, plus one saved example per documented response (filled from the document's examples or from its schemas), so a mock server can answer right away.</span>
      <span>The collection stays linked to the document on this device: responses are checked against it, and <strong>OpenAPI…</strong> in the collection's menu updates the requests when the document changes, without touching your scripts or your own examples.</span>
    </InfoTip>
  </p>
</section>
