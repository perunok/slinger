<script lang="ts" module>
  import type { OpenApiValidation } from '../../../shared/types'

  /** Spec checks by response, so switching back to a tab does not check its response again. */
  const specChecks = new WeakMap<object, OpenApiValidation | null>()
</script>

<script lang="ts">
  /** What sits under the request editor: empty state, progress, inline error or the response viewer. */
  import { untrack } from 'svelte'
  import { scopeStore } from '../../app/scope.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import NameDialog from '../../components/ui/NameDialog.svelte'
  import { defaultExampleName, openExample, saveResponseAsExample } from '../examples/actions'
  import type { RequestTab } from '../requests/tabs.svelte'
  import { tabsStore } from '../requests/tabs.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import ResponseViewer from './ResponseViewer.svelte'
  import SendingStatus from './SendingStatus.svelte'
  import ConsoleView from '../scripts/ConsoleView.svelte'
  import { checkResponseAgainstSpec } from '../openapi/openapiStore.svelte'
  import SpecChip from '../openapi/SpecChip.svelte'

  let { tab }: { tab: RequestTab } = $props()

  /** How the shown response compares with the collection's OpenAPI document (null: not checked / nothing to check). */
  let spec = $state.raw<{ for: unknown; result: OpenApiValidation } | null>(null)
  const SPEC_DEBOUNCE_MS = 150
  $effect(() => {
    const response = tab.response
    const collectionId = tab.collectionId
    if (!response || !collectionId || tab.sending) return
    if (specChecks.has(response)) {
      const known = specChecks.get(response)
      spec = known ? { for: response, result: known } : null
      return
    }
    // The request as it was sent (later edits to the draft do not re-check this response).
    const target = untrack(() => ({ collectionId, requestId: tab.requestId, method: tab.draft.method, url: tab.draft.url }))
    let stale = false
    const timer = setTimeout(async () => {
      const result = await checkResponseAgainstSpec(target, response.data)
      specChecks.set(response, result)
      if (!stale) spec = result ? { for: response, result } : null
    }, SPEC_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  })
  const specResult = $derived(spec && spec.for === tab.response ? spec.result : null)

  let naming = $state(false)
  const saveTitle = $derived(
    sync.blocked ? `${sync.blockedMessage} Saving is disabled.` : !tab.requestId ? 'Save the request first, then save its responses as examples' : 'Keep this response as a saved example of the request',
  )

  async function saveExample(name: string) {
    const requestId = tab.requestId
    const response = tab.response?.data
    if (!requestId || !response) throw new Error('There is no response to save.')
    const saved = await saveResponseAsExample(requestId, name, $state.snapshot(tab.draft), response)
    toast.offer('Example saved', saved.note ? `“${name}”. ${saved.note}` : `“${name}” is listed under the request.`, {
      label: 'Open example',
      run: () => openExample(requestId, saved.index),
    })
  }
</script>

<div class="relative flex h-full min-h-0 flex-col bg-surface" aria-label="Response" role="region">
  {#key tab}
    <SendingStatus sending={tab.sending} outcome={tab.lastOutcome} startedAt={tab.sendStartedAt} oncancel={() => tabsStore.cancel(tab)} />
  {/key}
  {#if tab.error}
    <div role="alert" class="m-3 rounded border border-danger bg-danger-soft p-3 text-sm" data-testid="send-error">
      <p class="font-medium text-danger">The request was not sent</p>
      <p class="mt-1">{tab.error.message}</p>
      {#if tab.error.unresolved.length}
        <ul class="mt-2 flex flex-wrap gap-2">
          {#each tab.error.unresolved as name (name)}
            <li>
              <Button size="sm" icon="plus" onclick={() => scopeStore.createVariable?.(name)}>Create <code>{name}</code></Button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if tab.error && !tab.response && tab.scriptOutput && tab.scriptOutput.console.length > 0}
    <div class="mx-3 mb-3 min-h-24 flex-1 overflow-hidden rounded border border-border" data-testid="error-console">
      <ConsoleView entries={tab.scriptOutput.console} />
    </div>
  {/if}
  {#if tab.sending}
    <!-- SendingStatus above -->
  {:else if tab.response}
    {#if tab.warnings.length}
      <ul class="border-b border-border bg-warning-soft px-3 py-1 text-xs text-warning">
        {#each tab.warnings as w (w)}<li>{w}</li>{/each}
      </ul>
    {/if}
    <div class="min-h-0 flex-1">
      <ResponseViewer
        data={tab.response.data}
        view={tab.responseView}
        onviewchange={(v) => (tab.responseView = v)}
        scripts={tab.scriptOutput}
        onclearconsole={() => tab.scriptOutput && (tab.scriptOutput = { ...tab.scriptOutput, console: [] })}
      >
        {#snippet chips()}
          {#if specResult}<SpecChip result={specResult} />{/if}
        {/snippet}
        {#snippet actions()}
          <Button size="sm" icon="save" class="mr-1" disabled={sync.blocked || !tab.requestId} title={saveTitle} onclick={() => (naming = true)}>Save as example</Button>
        {/snippet}
      </ResponseViewer>
    </div>
  {:else if !tab.error}
    <div class="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted">
      <p>Enter a URL and press <kbd class="rounded border border-border bg-raised px-1">Send</kbd></p>
      <p class="text-xs text-faint">Ctrl+Enter also sends the request</p>
    </div>
  {/if}
</div>

{#if naming && tab.response}
  <NameDialog
    title="Save as example"
    label="Example name"
    initial={defaultExampleName(tab.response.data)}
    submitLabel="Save example"
    onsubmit={saveExample}
    oncancel={() => (naming = false)}
  />
{/if}
