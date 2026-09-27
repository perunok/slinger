<script lang="ts">
  /** Shows / hides the right side panel (status bar and top bar). A toggle button: constant name, aria-pressed. */
  import IconButton from '../../components/ui/IconButton.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { RIGHT_PANEL_SHORTCUT, rightPanelLabel, toggleRightPanel } from './layoutActions'
  import { rightPanel } from './rightPanelStore.svelte'

  let { variant = 'top' }: { variant?: 'top' | 'bar' } = $props()
  const title = $derived(`${rightPanelLabel()} (${RIGHT_PANEL_SHORTCUT})`)
</script>

{#if variant === 'top'}
  <IconButton icon="panel-right" label="Right panel" title={title} active={rightPanel.open} aria-pressed={rightPanel.open} data-testid="right-panel-toggle-top" onclick={toggleRightPanel} />
{:else}
  <button
    type="button"
    aria-label="Right panel"
    aria-pressed={rightPanel.open}
    {title}
    data-testid="right-panel-toggle"
    class="flex h-5 w-6 items-center justify-center rounded hover:bg-hover hover:text-fg {rightPanel.open ? (rightPanel.room ? 'text-accent-text' : 'text-warning') : 'text-muted'}"
    onclick={toggleRightPanel}
  >
    <Icon name="panel-right" size={13} />
  </button>
{/if}
