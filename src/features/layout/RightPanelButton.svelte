<script lang="ts">
  /** Shows / hides the right side panel (top bar). A toggle button: constant name, aria-pressed. */
  import IconButton from '../../components/ui/IconButton.svelte'
  import { RIGHT_PANEL_SHORTCUT, rightPanelLabel, toggleRightPanel } from './layoutActions'
  import { rightPanel } from './rightPanelStore.svelte'

  const title = $derived(`${rightPanelLabel()} (${RIGHT_PANEL_SHORTCUT})`)
</script>

<!-- Amber while it is on but hidden for lack of room (its title says so too). -->
<IconButton
  icon="panel-right"
  label="Right panel"
  {title}
  active={rightPanel.open}
  aria-pressed={rightPanel.open}
  class={rightPanel.open && !rightPanel.room ? '!text-warning' : ''}
  data-testid="right-panel-toggle"
  data-room={rightPanel.room}
  onclick={toggleRightPanel}
/>
