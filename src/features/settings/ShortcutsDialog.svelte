<script lang="ts">
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'

  const rows = [
    ['Ctrl+Enter', 'Send the current request'],
    ['Ctrl+S', 'Save the current request'],
    ['Ctrl+T', 'New request tab'],
    ['Ctrl+W', 'Close the current tab'],
    ['Ctrl+K', 'Go to request'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+,', 'Settings'],
    ['Ctrl+/', 'This list'],
    ['Enter (in a table cell)', 'Move to the cell below'],
    ['F2 / Delete (in the tree)', 'Rename / delete the selected item'],
  ]
</script>

<Dialog title="Keyboard shortcuts" onclose={() => (ui.shortcutsOpen = false)} size="md">
  <table class="w-full text-sm">
    <tbody>
      {#each rows as [k, d] (k)}
        <tr class="border-b border-border last:border-0">
          <td class="py-1.5 pr-4"><kbd class="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-xs">{k}</kbd></td>
          <td class="py-1.5 text-muted">{d}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#snippet footer()}<Button variant="primary" onclick={() => (ui.shortcutsOpen = false)}>Close</Button>{/snippet}
</Dialog>
