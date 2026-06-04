<script lang="ts">
  import AuthTemplateInput from './AuthTemplateInput.svelte'
  import {
    authDocumentFromEditable,
    normalizeRequestAuth,
    type AuthLocation,
    type EditableAuth,
    type RequestAuthDocument,
    type SupportedAuthMethod,
  } from '../lib/authDocument'
  import type { EnvironmentVariable } from '../tauri'

  export let auth: unknown
  export let setAuth: (auth: RequestAuthDocument | null) => void
  export let environmentVariables: EnvironmentVariable[] = []

  const AUTH_METHODS: Array<{ value: SupportedAuthMethod; label: string }> = [
    { value: 'noauth', label: 'No Auth' },
    { value: 'apikey', label: 'API Key' },
    { value: 'bearer', label: 'Bearer Token' },
    { value: 'basic', label: 'Basic Auth' },
    { value: 'oauth2', label: 'OAuth 2.0' },
  ]

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  function save(nextAuth: EditableAuth) {
    setAuth(authDocumentFromEditable(nextAuth))
  }

  function setMethod(method: SupportedAuthMethod) {
    save({
      ...editableAuth,
      method,
    })
  }

  function setMethodFromEvent(event: Event) {
    const method = selectValue(event)
    if (method === 'unsupported') return

    setMethod(method as SupportedAuthMethod)
  }

  function setApiKeyLocationFromEvent(event: Event) {
    updateApiKey({ location: selectValue(event) as AuthLocation })
  }

  function updateApiKey(patch: Partial<EditableAuth['apiKey']>) {
    save({
      ...editableAuth,
      method: 'apikey',
      apiKey: {
        ...editableAuth.apiKey,
        ...patch,
      },
    })
  }

  function updateBearer(patch: Partial<EditableAuth['bearer']>) {
    save({
      ...editableAuth,
      method: 'bearer',
      bearer: {
        ...editableAuth.bearer,
        ...patch,
      },
    })
  }

  function updateBasic(patch: Partial<EditableAuth['basic']>) {
    save({
      ...editableAuth,
      method: 'basic',
      basic: {
        ...editableAuth.basic,
        ...patch,
      },
    })
  }

  function updateOAuth2(patch: Partial<EditableAuth['oauth2']>) {
    save({
      ...editableAuth,
      method: 'oauth2',
      oauth2: {
        ...editableAuth.oauth2,
        ...patch,
      },
    })
  }

  $: editableAuth = normalizeRequestAuth(auth)
  $: selectedMethod = editableAuth.method === 'unsupported' ? 'unsupported' : editableAuth.method
</script>

<div class="h-full overflow-auto p-4">
  <div class="max-w-3xl space-y-4">
    <div class="grid max-w-md gap-1.5">
      <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-method">Type</label>
      <div class="relative flex items-center">
        <select
          id="auth-method"
          value={selectedMethod}
          class="select-field h-9 w-full rounded pl-3 pr-8 text-sm outline-none appearance-none focus:border-[#5a8fff]"
          on:change={setMethodFromEvent}
        >
          {#if editableAuth.method === 'unsupported'}
            <option value="unsupported">Unsupported ({editableAuth.unsupportedType})</option>
          {/if}
          {#each AUTH_METHODS as method}
            <option value={method.value}>{method.label}</option>
          {/each}
        </select>
        <div class="pointer-events-none absolute right-2.5 text-[var(--muted)]">
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </div>
      </div>
    </div>

    {#if editableAuth.method === 'apikey'}
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div class="grid gap-1.5">
          <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-api-key-key">Key</label>
          <AuthTemplateInput
            id="auth-api-key-key"
            value={editableAuth.apiKey.key}
            setValue={(key) => updateApiKey({ key })}
            {environmentVariables}
            className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
          />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-api-key-value">Value</label>
          <AuthTemplateInput
            id="auth-api-key-value"
            value={editableAuth.apiKey.value}
            setValue={(value) => updateApiKey({ value })}
            {environmentVariables}
            sensitive
            className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
          />
        </div>
        <label class="grid max-w-xs gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Add To</span>
          <select
            value={editableAuth.apiKey.location}
            class="select-field h-9 rounded px-3 text-sm outline-none focus:border-[#5a8fff]"
            on:change={setApiKeyLocationFromEvent}
          >
            <option value="header">Header</option>
            <option value="query">Query Param</option>
          </select>
        </label>
      </div>
    {:else if editableAuth.method === 'bearer'}
      <div class="grid max-w-xl gap-1.5">
        <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-bearer-token">Token</label>
        <AuthTemplateInput
          id="auth-bearer-token"
          value={editableAuth.bearer.token}
          setValue={(token) => updateBearer({ token })}
          {environmentVariables}
          sensitive
          showVisibilityToggle
          visibleByDefault
          className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
        />
      </div>
    {:else if editableAuth.method === 'basic'}
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div class="grid gap-1.5">
          <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-basic-username">Username</label>
          <AuthTemplateInput
            id="auth-basic-username"
            value={editableAuth.basic.username}
            setValue={(username) => updateBasic({ username })}
            {environmentVariables}
            className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
          />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-basic-password">Password</label>
          <AuthTemplateInput
            id="auth-basic-password"
            value={editableAuth.basic.password}
            setValue={(password) => updateBasic({ password })}
            {environmentVariables}
            sensitive
            className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
          />
        </div>
      </div>
    {:else if editableAuth.method === 'oauth2'}
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
        <div class="grid gap-1.5">
          <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-oauth2-access-token">Access Token</label>
          <AuthTemplateInput
            id="auth-oauth2-access-token"
            value={editableAuth.oauth2.accessToken}
            setValue={(accessToken) => updateOAuth2({ accessToken })}
            {environmentVariables}
            sensitive
            className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
          />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-semibold uppercase text-[var(--muted)]" for="auth-oauth2-token-type">Token Type</label>
          <AuthTemplateInput
            id="auth-oauth2-token-type"
            value={editableAuth.oauth2.tokenType}
            setValue={(tokenType) => updateOAuth2({ tokenType })}
            {environmentVariables}
            className="h-9 w-full rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm leading-9 text-[var(--text)] outline-none focus:border-[#5a8fff]"
          />
        </div>
      </div>
    {:else if editableAuth.method === 'unsupported'}
      <div class="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-3 text-sm text-[var(--muted)]">
        Imported auth type: {editableAuth.unsupportedType}
      </div>
    {/if}
  </div>
</div>
