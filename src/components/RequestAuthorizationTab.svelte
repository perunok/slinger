<script lang="ts">
  import {
    authDocumentFromEditable,
    normalizeRequestAuth,
    type AuthLocation,
    type EditableAuth,
    type RequestAuthDocument,
    type SupportedAuthMethod,
  } from '../lib/authDocument'

  export let auth: unknown
  export let setAuth: (auth: RequestAuthDocument | null) => void

  const AUTH_METHODS: Array<{ value: SupportedAuthMethod; label: string }> = [
    { value: 'noauth', label: 'No Auth' },
    { value: 'apikey', label: 'API Key' },
    { value: 'bearer', label: 'Bearer Token' },
    { value: 'basic', label: 'Basic Auth' },
    { value: 'oauth2', label: 'OAuth 2.0' },
  ]

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

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
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Key</span>
          <input
            value={editableAuth.apiKey.key}
            class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
            on:input={(event) => updateApiKey({ key: inputValue(event) })}
          />
        </label>
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Value</span>
          <input
            value={editableAuth.apiKey.value}
            type="password"
            class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
            on:input={(event) => updateApiKey({ value: inputValue(event) })}
          />
        </label>
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
      <label class="grid max-w-xl gap-1.5">
        <span class="text-xs font-semibold uppercase text-[var(--muted)]">Token</span>
        <input
          value={editableAuth.bearer.token}
          type="password"
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
          on:input={(event) => updateBearer({ token: inputValue(event) })}
        />
      </label>
    {:else if editableAuth.method === 'basic'}
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Username</span>
          <input
            value={editableAuth.basic.username}
            class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
            on:input={(event) => updateBasic({ username: inputValue(event) })}
          />
        </label>
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Password</span>
          <input
            value={editableAuth.basic.password}
            type="password"
            class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
            on:input={(event) => updateBasic({ password: inputValue(event) })}
          />
        </label>
      </div>
    {:else if editableAuth.method === 'oauth2'}
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Access Token</span>
          <input
            value={editableAuth.oauth2.accessToken}
            type="password"
            class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
            on:input={(event) => updateOAuth2({ accessToken: inputValue(event) })}
          />
        </label>
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase text-[var(--muted)]">Token Type</span>
          <input
            value={editableAuth.oauth2.tokenType}
            class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm outline-none focus:border-[#5a8fff]"
            on:input={(event) => updateOAuth2({ tokenType: inputValue(event) })}
          />
        </label>
      </div>
    {:else if editableAuth.method === 'unsupported'}
      <div class="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-3 text-sm text-[var(--muted)]">
        Imported auth type: {editableAuth.unsupportedType}
      </div>
    {/if}
  </div>
</div>
