<script lang="ts">
  /** A workflow tab: loads the workflow, then the editor (Svelte Flow needs its provider around the editor). */
  import { SvelteFlowProvider } from '@xyflow/svelte'
  import type { Workflow } from '../../../shared/types'
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import type { RequestTab } from '../requests/tabs.svelte'
  import WorkflowEditor from './WorkflowEditor.svelte'

  let { tab }: { tab: RequestTab } = $props()

  let workflow = $state.raw<Workflow | null>(null)
  let error = $state<string | null>(null)

  async function load() {
    error = null
    try {
      workflow = await api().getWorkflow(tab.workflowId!)
    } catch (e) {
      error = errorInfo(e).message
    }
  }
  $effect(() => {
    void tab.workflowId
    void load()
  })
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="workflow-view">
  {#if error}
    <div class="m-4 flex flex-col items-start gap-2">
      <InlineError message="Could not open the workflow: {error}" />
      <Button size="sm" icon="refresh" onclick={() => load()}>Retry</Button>
    </div>
  {:else if !workflow}
    <div class="flex flex-1 items-center justify-center gap-2 text-sm text-muted"><Spinner /> Loading workflow</div>
  {:else}
    {#key workflow.id}
      <SvelteFlowProvider>
        <WorkflowEditor initial={workflow} />
      </SvelteFlowProvider>
    {/key}
  {/if}
</div>
