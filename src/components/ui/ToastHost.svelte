<script lang="ts">
  import { toast } from '../../app/toast.svelte'
  import { onDialogCountChange } from './dialogStack'
  import Icon from './Icon.svelte'
  import IconButton from './IconButton.svelte'

  // While a dialog is open, toasts move away from the dialog's right-aligned buttons and let clicks through,
  // so a notification can never block e.g. a dialog's Done/Save button.
  let dialogOpen = $state(false)
  $effect(() => onDialogCountChange((n) => (dialogOpen = n > 0)))

  const styles = {
    error: 'border-danger bg-danger-soft',
    success: 'border-success bg-success-soft',
    info: 'border-strong bg-raised',
  }
  const icons = { error: 'alert', success: 'check', info: 'info' }
</script>

<div
  class="pointer-events-none fixed bottom-3 z-[70] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2 {dialogOpen ? 'left-3' : 'right-3'}"
  aria-live="polite"
  data-testid="toast-host"
  data-dialog-open={dialogOpen}
>
  {#each toast.items as t (t.id)}
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      class="flex items-start gap-2 rounded-md border p-2.5 shadow-pop {dialogOpen ? 'pointer-events-none' : 'pointer-events-auto'} {styles[t.kind]}"
    >
      <Icon name={icons[t.kind]} class="mt-0.5 shrink-0 {t.kind === 'error' ? 'text-danger' : t.kind === 'success' ? 'text-success' : 'text-muted'}" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">{t.title}</div>
        {#if t.detail}<div class="mt-0.5 break-words text-xs text-muted">{t.detail}</div>{/if}
        {#if t.action}
          {@const action = t.action}
          <button
            type="button"
            class="mt-1.5 rounded border border-strong px-2 py-0.5 text-xs font-medium hover:bg-hover"
            onclick={() => {
              toast.dismiss(t.id)
              action.run()
            }}>{action.label}</button
          >
        {/if}
      </div>
      <IconButton icon="x" label="Dismiss notification" size={13} onclick={() => toast.dismiss(t.id)} />
    </div>
  {/each}
</div>
