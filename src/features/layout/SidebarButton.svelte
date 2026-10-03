<script lang="ts">
  /** Shows / hides the sidebar (title bar). A toggle button: constant name, aria-pressed. */
  import { settings } from '../../app/settings.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import { SIDEBAR_SHORTCUT, toggleSidebar } from './layoutActions'
</script>

<IconButton
  icon="panel-left"
  label="Sidebar"
  title="{settings.showSidebar ? 'Hide' : 'Show'} sidebar ({SIDEBAR_SHORTCUT})"
  active={settings.showSidebar}
  aria-pressed={settings.showSidebar}
  data-testid="sidebar-toggle"
  onclick={toggleSidebar}
/>
