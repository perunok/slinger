<script lang="ts">
  import Icon from '../../components/ui/Icon.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import type { TemplateScope } from '../../lib/template'
  import { isBlank, type Row } from './envLogic'
  import type { EnvModel } from './envModel.svelte'

  interface Props {
    row: Row
    model: EnvModel
    scope: TemplateScope
  }
  let { row, model, scope }: Props = $props()

  let keyEl = $state<HTMLInputElement>()
  let valueEl = $state<ReturnType<typeof TemplateInput>>()
  let secretEl = $state<HTMLInputElement>()

  const issue = $derived(model.issueOf(row.rid))
  const duplicate = $derived(model.duplicates.has(row.rid))
  const qstate = $derived(model.stateOf(row.rid))
  const saveError = $derived(qstate === 'error' ? model.errorOf(row.rid) : model.revealError[row.rid])
  const blank = $derived(isBlank(row))
  const kept = $derived(row.isSecret && row.serverSecret && !row.secretTouched && !row.revealed)
  const name = $derived(row.key || 'new variable')

  $effect(() => {
    const f = model.focusRequest
    if (!f || f.rid !== row.rid) return
    model.focusRequest = null
    queueMicrotask(() => {
      if (f.field === 'key') keyEl?.focus()
      else if (row.isSecret) secretEl?.focus()
      else valueEl?.focus('end')
    })
  })
</script>

<div
  role="row"
  data-testid="env-row"
  data-duplicate={duplicate || undefined}
  class="border-b border-border px-2 py-1 {duplicate ? 'bg-warning-soft' : ''} {row.deleted ? 'opacity-50' : ''}"
>
  <div class="grid grid-cols-[minmax(7rem,1fr)_minmax(9rem,2fr)_4rem_5.5rem] items-center gap-2">
    <input
      bind:this={keyEl}
      type="text"
      aria-label="Variable name{blank ? ' (new)' : ': ' + name}"
      aria-invalid={issue ? true : undefined}
      placeholder="Variable name"
      spellcheck="false"
      autocomplete="off"
      disabled={row.deleted}
      value={row.key}
      oninput={(e) => model.edit(row.rid, { key: e.currentTarget.value })}
      onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), (row.isSecret ? secretEl : valueEl)?.focus?.())}
      class="h-7 min-w-0 rounded border bg-surface px-2 font-mono text-xs text-fg outline-none focus:border-accent {issue || duplicate ? 'border-danger' : 'border-border'}"
    />
    <div class="flex min-w-0 items-center gap-1">
      {#if row.isSecret}
        <input
          bind:this={secretEl}
          type={row.revealed ? 'text' : 'password'}
          aria-label="Secret value: {name}"
          placeholder={kept ? '•••••••• (unchanged)' : 'Secret value'}
          autocomplete="new-password"
          spellcheck="false"
          disabled={row.deleted}
          value={row.value}
          oninput={(e) => model.edit(row.rid, { value: e.currentTarget.value })}
          class="h-7 min-w-0 flex-1 rounded border border-border bg-surface px-2 font-mono text-xs text-fg outline-none focus:border-accent"
        />
        <IconButton
          icon={row.revealed ? 'eye-off' : 'eye'}
          label="{row.revealed ? 'Hide' : 'Reveal'} secret {name}"
          disabled={row.deleted || model.revealing[row.rid]}
          onclick={() => model.reveal(row.rid)}
        />
      {:else}
        <TemplateInput
          bind:this={valueEl}
          class="h-7 flex-1 border-border bg-surface text-xs"
          mono
          {scope}
          label="Variable value"
          placeholder="Value"
          disabled={row.deleted}
          value={row.value}
          oninput={(v) => model.edit(row.rid, { value: v })}
        />
      {/if}
    </div>
    <label class="flex items-center justify-center gap-1 text-xs text-muted" title="Store this value as a secret">
      <input
        type="checkbox"
        aria-label="Secret: {name}"
        checked={row.isSecret}
        disabled={row.deleted || blank}
        onchange={() => model.toggleSecret(row.rid)}
      />
      <Icon name="lock" size={12} />
    </label>
    <div class="flex items-center justify-end gap-1 text-xs">
      {#if qstate === 'saving'}
        <span class="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" role="status" aria-label="Saving"></span>
      {:else if qstate === 'saved' && !row.deleted}
        <span class="text-success" role="img" aria-label="Saved"><Icon name="check" size={14} /></span>
      {:else if qstate === 'error'}
        <span class="text-danger" role="img" aria-label="Save failed"><Icon name="alert" size={14} /></span>
      {/if}
      {#if !blank}
        <IconButton icon="trash" label="Delete variable {name}" disabled={row.deleted} onclick={() => model.remove(row.rid)} />
      {/if}
    </div>
  </div>
  {#if issue}
    <p class="mt-0.5 text-xs text-danger" data-testid="row-issue">{issue}</p>
  {:else if saveError}
    <p class="mt-0.5 flex items-center gap-2 text-xs text-danger" role="alert">
      <span>{qstate === 'error' ? 'Not saved: ' : ''}{saveError}</span>
      {#if qstate === 'error'}
        <button type="button" class="rounded border border-danger px-1.5 text-danger hover:bg-danger-soft" onclick={() => model.queue.retry(row.rid)}>Retry</button>
      {/if}
    </p>
  {/if}
</div>
