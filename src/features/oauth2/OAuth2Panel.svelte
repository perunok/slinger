<script lang="ts">
  /**
   * OAuth 2.0 settings of a request (Authorization tab) plus the token actions. The settings are part of the request
   * document; the token is not: main gets and keeps it (OS keychain) and this panel only sees its status, except
   * after an explicit Reveal.
   */
  import { onDestroy } from 'svelte'
  import { DEFAULT_OAUTH2_REDIRECT_URI } from '../../../shared/oauth2'
  import type { OAuth2TokenStatus } from '../../../shared/types'
  import { scopeStore } from '../../app/scope.svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import Button from '../../components/ui/Button.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { describeTokenStatus, GRANT_LABELS, isAuthCodeGrant, isSupportedGrant, unsupportedGrantMessage, type OAuth2Purpose } from '../../lib/oauth2'
  import { oauth2IdentityTexts, type OAuth2Draft } from '../../lib/request'
  import { uuid } from '../../lib/template'
  import type { RequestTab } from '../requests/tabs.svelte'
  import { resolveOAuth2 } from './oauth2Actions'

  let { tab }: { tab: RequestTab } = $props()
  const o = $derived(tab.draft.auth.oauth2)
  const set = <K extends keyof OAuth2Draft>(key: K, value: OAuth2Draft[K]) => (tab.draft.auth.oauth2[key] = value)

  const supported = $derived(isSupportedGrant(o.grantType))
  const authCode = $derived(isAuthCodeGrant(o.grantType))
  const pkce = $derived(o.grantType === 'authorization_code_with_pkce')
  const password = $derived(o.grantType === 'password_credentials')

  let revealSecrets = $state(false)
  let status = $state<OAuth2TokenStatus | null>(null)
  /** Why the status cannot be shown (unresolved variable, keychain error). */
  let statusNote = $state<string | null>(null)
  let busy = $state<'get' | 'refresh' | 'clear' | null>(null)
  let error = $state<string | null>(null)
  let flowId = $state<string | null>(null)
  let revealed = $state<string | null>(null)
  let destroyed = false

  const ctx = () => ({ workspaceId: app.workspaceId ?? '', collectionId: tab.collectionId })

  const resolved = (purpose: OAuth2Purpose) => resolveOAuth2($state.snapshot(tab.draft.auth.oauth2) as OAuth2Draft, ctx(), purpose)

  let statusSeq = 0
  async function loadStatus() {
    const seq = ++statusSeq
    if (!app.workspaceId || !supported) {
      status = null
      statusNote = null
      return
    }
    const r = await resolved('status')
    if (seq !== statusSeq || destroyed) return
    if (!r.ok) {
      status = null
      statusNote = r.error
      return
    }
    try {
      const s = await api().getOAuth2TokenStatus(r.config)
      if (seq !== statusSeq || destroyed) return
      if (s.tokenKey !== status?.tokenKey) revealed = null
      status = s
      statusNote = null
    } catch (e) {
      if (seq === statusSeq) statusNote = errorInfo(e).message
    }
  }

  // Re-read the status when the settings that identify the token, or the variables they use, change (debounced while typing).
  const identity = $derived(JSON.stringify([app.workspaceId, o.grantType, ...oauth2IdentityTexts(o)]))
  $effect(() => {
    void identity
    void scopeStore.scope
    const timer = setTimeout(() => void loadStatus(), 250)
    return () => clearTimeout(timer)
  })

  onDestroy(() => {
    destroyed = true
    if (flowId) void api().cancelOAuth2Flow(flowId).catch(() => {})
  })

  async function getToken() {
    error = null
    const r = await resolved('token')
    if (!r.ok) return void (error = r.error)
    busy = 'get'
    const id = uuid()
    flowId = id
    try {
      status = await api().getOAuth2Token(r.config, { flowId: id })
      revealed = null
      statusNote = null
      toast.success('Access token received', 'Stored in the OS keychain.')
    } catch (e) {
      const info = errorInfo(e)
      if (!info.details?.cancelled) error = info.message
    } finally {
      busy = null
      flowId = null
    }
  }

  async function cancelFlow() {
    if (flowId) await api().cancelOAuth2Flow(flowId).catch(() => {})
  }

  async function refresh() {
    error = null
    const r = await resolved('send')
    if (!r.ok) return void (error = r.error)
    busy = 'refresh'
    try {
      status = await api().refreshOAuth2Token(r.config)
      revealed = null
      toast.success('Access token refreshed')
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = null
    }
  }

  async function clear() {
    if (!status?.hasToken) return
    error = null
    busy = 'clear'
    try {
      await api().deleteOAuth2Token(status.tokenKey)
      revealed = null
      await loadStatus()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = null
    }
  }

  async function toggleReveal() {
    if (revealed !== null) return void (revealed = null)
    if (!status?.hasToken) return
    try {
      revealed = await api().revealOAuth2Token(status.tokenKey)
    } catch (e) {
      error = errorInfo(e).message
    }
  }

  const statusLine = $derived(describeTokenStatus(status))
  const GRANTS = ['authorization_code_with_pkce', 'authorization_code', 'client_credentials', 'password_credentials'] as const
</script>

{#snippet field(label: string, value: string, key: keyof OAuth2Draft, opts: { secret?: boolean; placeholder?: string } = {})}
  <div class="grid gap-1">
    <span class="text-xs text-muted">{label}</span>
    <div class="flex items-center gap-1">
      <div class="min-w-0 flex-1 rounded border border-border bg-surface px-1 py-0.5 focus-within:border-accent">
        <TemplateInput
          class="w-full !border-transparent"
          {label}
          {value}
          oninput={(v) => set(key, v as never)}
          masked={!!opts.secret && !revealSecrets}
          placeholder={opts.placeholder ?? ''}
        />
      </div>
      {#if opts.secret}
        <IconButton icon={revealSecrets ? 'eye-off' : 'eye'} label={revealSecrets ? 'Hide secret values' : 'Show secret values'} active={revealSecrets} onclick={() => (revealSecrets = !revealSecrets)} />
      {/if}
    </div>
  </div>
{/snippet}

<div class="space-y-3" data-testid="oauth2-panel">
  <div class="grid gap-1">
    <label for="oauth2-grant" class="text-xs text-muted">Grant type</label>
    <select id="oauth2-grant" class="w-72" value={o.grantType} onchange={(e) => set('grantType', e.currentTarget.value)}>
      {#each GRANTS as g (g)}<option value={g}>{GRANT_LABELS[g]}</option>{/each}
      {#if !supported}<option value={o.grantType}>{o.grantType === 'implicit' ? GRANT_LABELS.implicit : `${o.grantType} (not supported)`}</option>{/if}
    </select>
  </div>

  {#if !supported}
    <p class="rounded border border-warning bg-warning-soft px-3 py-2 text-sm" data-testid="oauth2-unsupported">
      {unsupportedGrantMessage(o.grantType)} The settings are kept when you save.
    </p>
  {:else}
    <!-- Token -->
    <section class="space-y-2 rounded border border-border bg-raised p-2.5" aria-label="Access token">
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" icon="key" loading={busy === 'get'} disabled={busy !== null} onclick={getToken}>Get New Access Token</Button>
        {#if busy === 'get' && authCode}
          <Button size="sm" onclick={cancelFlow}>Cancel</Button>
        {/if}
        {#if status?.hasToken}
          {#if status.hasRefreshToken}
            <Button size="sm" icon="refresh" loading={busy === 'refresh'} disabled={busy !== null} onclick={refresh}>Refresh</Button>
          {/if}
          <Button size="sm" icon={revealed !== null ? 'eye-off' : 'eye'} disabled={busy !== null} onclick={toggleReveal}>{revealed !== null ? 'Hide' : 'Reveal'}</Button>
          <Button size="sm" variant="ghost" icon="trash" loading={busy === 'clear'} disabled={busy !== null} onclick={clear}>Clear</Button>
        {/if}
      </div>
      {#if busy === 'get' && authCode}
        <p class="text-xs text-muted" role="status">Waiting for you to sign in in the browser… (up to 5 minutes)</p>
      {/if}
      <p
        class="text-xs {statusLine.tone === 'ok' ? 'text-success' : statusLine.tone === 'warn' ? 'text-warning' : 'text-muted'}"
        data-testid="oauth2-status"
      >
        {#if statusNote}<span class="text-muted">Token status unavailable: {statusNote}</span>{:else}{statusLine.text}{#if status?.hasToken && revealed === null}<span class="ml-2 font-mono text-faint">{status.maskedToken}</span>{/if}{/if}
      </p>
      {#if revealed !== null}
        <input class="w-full font-mono text-xs" readonly value={revealed} aria-label="Access token" data-testid="oauth2-revealed" />
      {/if}
      <InlineError message={error} />
      <p class="text-[11px] text-faint">Tokens are kept only in your OS keychain: never in the request, history, exports or sync.</p>
    </section>

    <!-- Settings -->
    {#if authCode}
      {@render field('Auth URL', o.authUrl, 'authUrl', { placeholder: 'https://provider.example/authorize' })}
    {/if}
    {@render field('Access Token URL', o.accessTokenUrl, 'accessTokenUrl', { placeholder: 'https://provider.example/token' })}
    {@render field('Client ID', o.clientId, 'clientId')}
    {@render field('Client Secret', o.clientSecret, 'clientSecret', { secret: true, placeholder: authCode ? 'Optional for public clients' : '' })}
    {#if password}
      {@render field('Username', o.username, 'username')}
      {@render field('Password', o.password, 'password', { secret: true })}
    {/if}
    {@render field('Scope', o.scope, 'scope', { placeholder: 'e.g. read write' })}
    {#if authCode}
      {@render field('Redirect URI', o.redirectUri, 'redirectUri', { placeholder: DEFAULT_OAUTH2_REDIRECT_URI })}
      <p class="-mt-2 text-[11px] text-faint">
        Register exactly this URI with the provider. It must be a loopback address (<code>http://127.0.0.1:&lt;port&gt;/…</code> or
        <code>localhost</code>): Slinger listens there for the browser's redirect.
      </p>
    {/if}

    <details class="rounded border border-border px-2.5 py-1.5">
      <summary class="cursor-pointer text-xs text-muted">Advanced</summary>
      <div class="mt-2 space-y-3 pb-1">
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1">
            <label for="oauth2-client-auth" class="text-xs text-muted">Client authentication</label>
            <select id="oauth2-client-auth" value={o.clientAuthentication} onchange={(e) => set('clientAuthentication', e.currentTarget.value === 'body' ? 'body' : 'header')}>
              <option value="header">Send as Basic Auth header</option>
              <option value="body">Send client credentials in body</option>
            </select>
          </div>
          <div class="grid gap-1">
            <label for="oauth2-add-to" class="text-xs text-muted">Add token to</label>
            <select id="oauth2-add-to" value={o.addTokenTo} onchange={(e) => set('addTokenTo', e.currentTarget.value === 'queryParams' ? 'queryParams' : 'header')}>
              <option value="header">Request header</option>
              <option value="queryParams">Query parameter (access_token)</option>
            </select>
          </div>
        </div>
        {#if o.addTokenTo === 'header'}
          {@render field('Header prefix', o.headerPrefix, 'headerPrefix', { placeholder: 'Empty = token only' })}
        {/if}
        {#if pkce}
          <div class="grid gap-1">
            <label for="oauth2-challenge" class="text-xs text-muted">Code challenge method</label>
            <select id="oauth2-challenge" class="w-56" value={o.challengeAlgorithm} onchange={(e) => set('challengeAlgorithm', e.currentTarget.value === 'plain' ? 'plain' : 'S256')}>
              <option value="S256">SHA-256</option>
              <option value="plain">Plain</option>
            </select>
          </div>
          {@render field('Code verifier', o.codeVerifier, 'codeVerifier', { placeholder: 'Generated for each sign-in when empty' })}
        {/if}
        {#if authCode}
          {@render field('State', o.state, 'state', { placeholder: 'Random for each sign-in when empty' })}
        {/if}
        {@render field('Refresh Token URL', o.refreshTokenUrl, 'refreshTokenUrl', { placeholder: 'Same as the Access Token URL when empty' })}
        {@render field('Audience', o.audience, 'audience', { placeholder: 'Optional (e.g. Auth0)' })}
        {@render field('Resource', o.resource, 'resource', { placeholder: 'Optional (e.g. Azure AD, RFC 8707)' })}
        {@render field('Token name', o.tokenName, 'tokenName', { placeholder: 'Label only' })}
      </div>
    </details>
  {/if}
</div>
