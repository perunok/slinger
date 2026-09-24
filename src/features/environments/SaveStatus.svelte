<script lang="ts">
  import Icon from '../../components/ui/Icon.svelte'
  import type { StatusKind } from './envLogic'

  interface Props {
    kind: StatusKind
    label: string
    onretry?: () => void
  }
  let { kind, label, onretry }: Props = $props()

  const tone: Record<StatusKind, string> = {
    saved: 'bg-success-soft text-success',
    saving: 'bg-raised text-muted',
    unsaved: 'bg-warning-soft text-warning',
    error: 'bg-danger-soft text-danger',
  }
</script>

{#if kind === 'error'}
  <button
    type="button"
    data-testid="save-status"
    data-kind={kind}
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs {tone[kind]} hover:brightness-95"
    onclick={() => onretry?.()}
  >
    <Icon name="alert" size={12} />{label}
  </button>
{:else}
  <span role="status" data-testid="save-status" data-kind={kind} class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs {tone[kind]}">
    {#if kind === 'saved'}<Icon name="check" size={12} />{:else if kind === 'saving'}<span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true"></span>{/if}{label}
  </span>
{/if}
