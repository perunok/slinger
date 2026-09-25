<script lang="ts">
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import type { AuthKind } from '../../lib/request'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const a = $derived(tab.draft.auth)
  let reveal = $state(false)

  const KINDS: { id: AuthKind; label: string }[] = [
    { id: 'none', label: 'No Auth' },
    { id: 'basic', label: 'Basic Auth' },
    { id: 'bearer', label: 'Bearer Token' },
    { id: 'apiKey', label: 'API Key' },
  ]
</script>

<div class="max-w-xl space-y-3 p-3">
  <div class="grid gap-1">
    <label for="auth-kind" class="text-xs text-muted">Authorization type</label>
    <select id="auth-kind" class="w-56" value={a.kind} onchange={(e) => (tab.draft.auth.kind = e.currentTarget.value as AuthKind)}>
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

  {#if a.kind === 'basic'}
    {@render field('Username', a.basic.username, (v) => (tab.draft.auth.basic.username = v))}
    {@render field('Password', a.basic.password, (v) => (tab.draft.auth.basic.password = v), { secret: true })}
  {:else if a.kind === 'bearer'}
    {@render field('Token', a.bearer.token, (v) => (tab.draft.auth.bearer.token = v), { secret: true, placeholder: 'Token or {{variable}}' })}
  {:else if a.kind === 'apiKey'}
    {@render field('Key', a.apiKey.key, (v) => (tab.draft.auth.apiKey.key = v), { placeholder: 'X-API-Key' })}
    {@render field('Value', a.apiKey.value, (v) => (tab.draft.auth.apiKey.value = v), { secret: true })}
    <div class="grid gap-1">
      <label for="auth-addto" class="text-xs text-muted">Add to</label>
      <select id="auth-addto" class="w-56" value={a.apiKey.addTo} onchange={(e) => (tab.draft.auth.apiKey.addTo = e.currentTarget.value === 'query' ? 'query' : 'header')}>
        <option value="header">Header</option>
        <option value="query">Query parameter</option>
      </select>
    </div>
  {:else if a.kind === 'unsupported'}
    <p class="rounded border border-warning bg-warning-soft px-3 py-2 text-sm">
      This request uses <strong>{a.unsupportedType ?? 'custom'}</strong> authorization, which Slinger cannot edit or send. The original settings are kept when you save;
      choose another type above to replace them.
    </p>
  {:else}
    <p class="text-sm text-muted">This request does not use any authorization.</p>
  {/if}
  {#if a.kind !== 'none' && a.kind !== 'unsupported'}
    <p class="text-xs text-faint">Values may use <code>{'{{variables}}'}</code>. Credentials are resolved when the request is sent.</p>
  {/if}
</div>
