<script lang="ts">
  /**
   * Auth settings editor, shared by a request's Authorization tab and a collection's / folder's Authorization section.
   * `level` decides which types exist: requests and folders can inherit from their parent (Postman's default), a
   * collection is the top and cannot. While inheriting, `inherited` (the resolved auth and where it comes from) is shown
   * read-only; `onopensource` opens that folder / collection to edit it.
   */
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import OAuth2Panel from '../oauth2/OAuth2Panel.svelte'
  import { AUTH_KIND_LABELS, authKindLabel, type AuthSource, type EffectiveAuth } from '../../lib/authInheritance'
  import type { AuthDraft, AuthKind } from '../../lib/request'

  interface Props {
    auth: AuthDraft
    level: 'request' | 'folder' | 'collection'
    /** Whose collection variables resolve OAuth 2.0 settings. */
    collectionId: string | null
    /** What `inherit` resolves to here (requests and folders). */
    inherited?: EffectiveAuth | null
    onopensource?: (source: AuthSource) => void
    readOnly?: boolean
  }
  let { auth = $bindable(), level, collectionId, inherited = null, onopensource, readOnly = false }: Props = $props()
  const a = $derived(auth)
  let reveal = $state(false)

  const KINDS = $derived(
    (['inherit', 'none', 'basic', 'bearer', 'apiKey', 'oauth2'] as AuthKind[])
      .filter((k) => k !== 'inherit' || level !== 'collection')
      .map((id) => ({ id, label: AUTH_KIND_LABELS[id] })),
  )
  const subject = $derived(level === 'request' ? 'This request' : `This ${level}`)
</script>

<div class="max-w-xl space-y-3 p-3" data-testid="auth-editor-{level}">
  <div class="grid gap-1">
    <label for="auth-kind-{level}" class="text-xs text-muted">Authorization type</label>
    <select id="auth-kind-{level}" class="w-56" value={a.kind} disabled={readOnly} onchange={(e) => (auth.kind = e.currentTarget.value as AuthKind)}>
      {#each KINDS as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
      {#if a.kind === 'unsupported'}<option value="unsupported">{a.unsupportedType ?? 'Custom'} (unsupported)</option>{/if}
    </select>
  </div>

  {#snippet field(label: string, value: string, set: (v: string) => void, opts: { secret?: boolean; placeholder?: string } = {})}
    <div class="grid gap-1">
      <span class="text-xs text-muted">{label}</span>
      <div class="flex items-center gap-1">
        <div class="min-w-0 flex-1 rounded border border-border bg-surface px-1 py-0.5 focus-within:border-accent">
          <TemplateInput class="w-full !border-transparent" {label} {value} oninput={set} masked={!!opts.secret && !reveal} placeholder={opts.placeholder ?? ''} />
        </div>
        {#if opts.secret}
          <IconButton icon={reveal ? 'eye-off' : 'eye'} label={reveal ? 'Hide secret values' : 'Show secret values'} active={reveal} onclick={() => (reveal = !reveal)} />
        {/if}
      </div>
    </div>
  {/snippet}

  {#if a.kind === 'inherit'}
    <div class="flex flex-wrap items-center gap-1.5 text-sm" data-testid="auth-inherited">
      {#if inherited?.source}
        <span>Inherited from</span>
        {#if onopensource}
          <button type="button" class="truncate rounded px-1 font-medium hover:bg-hover hover:text-fg" onclick={() => onopensource(inherited.source!)}
            >{inherited.source.name}</button
          >
        {:else}
          <strong class="truncate">{inherited.source.name}</strong>
        {/if}
        <span class="text-muted">({inherited.source.kind}):</span>
        <strong data-testid="auth-inherited-kind">{authKindLabel(inherited.auth)}</strong>
      {:else}
        <span class="text-muted" data-testid="auth-inherited-kind">{level === 'request' ? 'Not in a collection: sent without authorization.' : 'No auth'}</span>
      {/if}
      <InfoTip label="About inherited authorization">
        {subject} uses the authorization of the nearest folder above it that sets one, else the collection's, as in Postman.
        It is looked up when the request is sent, so changing it on the folder or collection changes every request that
        inherits it.{#if inherited?.auth.kind === 'oauth2'} Get the OAuth 2.0 token in that {inherited.source?.kind ?? 'collection'}'s
          Authorization section; requests that inherit the same settings share it.{/if}
      </InfoTip>
    </div>
  {:else if a.kind === 'basic'}
    {@render field('Username', a.basic.username, (v) => (auth.basic.username = v))}
    {@render field('Password', a.basic.password, (v) => (auth.basic.password = v), { secret: true })}
  {:else if a.kind === 'bearer'}
    {@render field('Token', a.bearer.token, (v) => (auth.bearer.token = v), { secret: true, placeholder: 'Token or {{variable}}' })}
  {:else if a.kind === 'apiKey'}
    {@render field('Key', a.apiKey.key, (v) => (auth.apiKey.key = v), { placeholder: 'X-API-Key' })}
    {@render field('Value', a.apiKey.value, (v) => (auth.apiKey.value = v), { secret: true })}
    <div class="grid gap-1">
      <label for="auth-addto-{level}" class="text-xs text-muted">Add to</label>
      <select id="auth-addto-{level}" class="w-56" value={a.apiKey.addTo} onchange={(e) => (auth.apiKey.addTo = e.currentTarget.value === 'query' ? 'query' : 'header')}>
        <option value="header">Header</option>
        <option value="query">Query parameter</option>
      </select>
    </div>
  {:else if a.kind === 'oauth2'}
    <OAuth2Panel bind:oauth2={auth.oauth2} {collectionId} />
  {:else if a.kind === 'unsupported'}
    <p class="rounded border border-warning bg-warning-soft px-3 py-2 text-sm">
      {subject} uses <strong>{a.unsupportedType ?? 'custom'}</strong> authorization, which Slinger cannot edit or send. The original settings are kept when you save;
      choose another type above to replace them.
    </p>
  {:else}
    <p class="text-sm text-muted">
      {subject} does not use any authorization{level === 'request' ? '' : level === 'folder' ? ', and neither do the requests in it that inherit' : '; requests that inherit send none'}.
    </p>
  {/if}
  {#if a.kind !== 'none' && a.kind !== 'unsupported' && a.kind !== 'inherit'}
    <p class="text-xs text-faint">
      Values may use <code>{'{{variables}}'}</code>. Credentials are resolved when the request is sent.{level !== 'request' ? ' Requests set to inherit use these settings.' : ''}
    </p>
  {/if}
</div>
