<script lang="ts">
  /**
   * Switches the response pane between below the request and beside it (a global setting). Sits on the divider
   * between the request editor and the response (SplitPane `action`) and in the status bar.
   */
  import { settings } from '../../app/settings.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { RESPONSE_POSITION_SHORTCUT, responsePositionLabel } from './layoutActions'

  let { variant = 'divider' }: { variant?: 'divider' | 'bar' } = $props()
  const label = $derived(responsePositionLabel(settings.responsePosition))
  // The icon shows the layout the button switches to.
  const icon = $derived(settings.responsePosition === 'below' ? 'layout-columns' : 'layout-rows')
</script>

<button
  type="button"
  aria-label={label}
  title="{label} ({RESPONSE_POSITION_SHORTCUT})"
  data-testid="response-position-toggle"
  data-position={settings.responsePosition}
  class={variant === 'divider'
    ? 'flex h-[18px] w-[18px] items-center justify-center rounded border border-strong bg-surface text-muted transition-colors hover:bg-hover hover:text-fg'
    : 'flex h-5 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg'}
  onclick={() => settings.toggleResponsePosition()}
>
  <Icon name={icon} size={variant === 'divider' ? 12 : 13} />
</button>
