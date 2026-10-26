<script lang="ts">
  import SecurityPromptDialog from './SecurityPromptDialog.svelte'
  import { securityPrompts } from './prompts.svelte'

  const prompt = $derived(securityPrompts.current)
</script>

{#if prompt}
  {#key prompt.id}
    <SecurityPromptDialog {prompt} />
  {/key}
{/if}
