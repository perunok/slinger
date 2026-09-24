<script lang="ts">
  import { toast } from '../../app/toast.svelte'
  import Icon from './Icon.svelte'
  import IconButton from './IconButton.svelte'

  const styles = {
    error: 'border-danger bg-danger-soft',
    success: 'border-success bg-success-soft',
    info: 'border-strong bg-raised',
  }
  const icons = { error: 'alert', success: 'check', info: 'info' }
</script>

<div class="pointer-events-none fixed bottom-3 right-3 z-[70] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2" aria-live="polite">
  {#each toast.items as t (t.id)}
    <div role={t.kind === 'error' ? 'alert' : 'status'} class="pointer-events-auto flex items-start gap-2 rounded-md border p-2.5 shadow-pop {styles[t.kind]}">
      <Icon name={icons[t.kind]} class="mt-0.5 shrink-0 {t.kind === 'error' ? 'text-danger' : t.kind === 'success' ? 'text-success' : 'text-muted'}" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">{t.title}</div>
        {#if t.detail}<div class="mt-0.5 break-words text-xs text-muted">{t.detail}</div>{/if}
      </div>
      <IconButton icon="x" label="Dismiss notification" size={13} onclick={() => toast.dismiss(t.id)} />
    </div>
  {/each}
</div>
