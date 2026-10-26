<script lang="ts">
  import { untrack } from 'svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import { securityPrompts, type SecurityPrompt } from './prompts.svelte'

  let { prompt }: { prompt: SecurityPrompt } = $props()
  // Fixed for this dialog: ConfirmDialog calls oncancel right after onconfirm, when the next prompt may be current.
  const id = untrack(() => prompt.id)
</script>

<ConfirmDialog
  title={prompt.title}
  message={prompt.message}
  confirmLabel={prompt.confirmLabel}
  onconfirm={() => securityPrompts.answer(id, true)}
  oncancel={() => securityPrompts.answer(id, false)}
/>
