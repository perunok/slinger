<script lang="ts">
  /**
   * A collection's mock server: start it on a port, copy its base URL, stop it, and watch the requests it answers.
   * The server runs in the main process; state comes from the `mockServers` store.
   */
  import { untrack } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { logTime, parsePort } from '../../lib/mockServers'
  import { statusTone } from '../../lib/response'
  import { methodColor } from '../requests/method'
  import { mockServers } from './mockServers.svelte'

  interface Props {
    collectionId: string
    onclose: () => void
    /** Opens the example that answered a logged request. */
    onopenexample: (requestId: string, exampleIndex: number) => void
  }
  let { collectionId, onclose, onopenexample }: Props = $props()

  const collection = $derived(app.collections.find((c) => c.id === collectionId) ?? null)
  const server = $derived(mockServers.servers[collectionId] ?? null)
  const busy = $derived(!!mockServers.busy[collectionId])
  const log = $derived([...(mockServers.logs[collectionId] ?? [])].reverse())
  const exampleCount = $derived(server ? server.exampleCount : mockServers.exampleCount(collectionId))

  let portText = $state(untrack(() => String(mockServers.suggestedPort(collectionId))))
  let portError = $state<string | null>(null)
  const error = $derived(portError ?? mockServers.errors[collectionId] ?? null)

  async function start(e?: Event) {
    e?.preventDefault()
    const parsed = parsePort(portText)
    if (parsed.port === null) {
      portError = parsed.error
      return
    }
    portError = null
    await mockServers.start(collectionId, parsed.port)
  }

  async function copyUrl() {
    if (!server) return
    try {
      await navigator.clipboard.writeText(server.url)
      toast.success('Copied to clipboard', server.url)
    } catch {
      toast.error('Could not copy', server.url)
    }
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const tone = (status: number) => ({ success: 'text-success', info: 'text-fg', warning: 'text-warning', danger: 'text-danger' })[statusTone(status)]
</script>

<Dialog title="Mock server · {collection?.name ?? 'Collection in another workspace'}" size="lg" {onclose}>
  <div class="flex flex-col gap-3 text-sm" data-testid="mock-server-dialog">
    {#if server}
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted">Base URL</span>
        <code class="min-w-0 truncate rounded border border-border bg-raised px-2 py-1 font-mono text-xs select-all" data-testid="mock-url">{server.url}</code>
        <IconButton icon="copy" label="Copy base URL" onclick={copyUrl} />
        <span class="flex-1"></span>
        <Button icon="stop" loading={busy} onclick={() => void mockServers.stop(collectionId)} data-testid="mock-stop">Stop</Button>
        {@render help()}
      </div>
    {:else}
      <form class="flex flex-wrap items-center gap-2" onsubmit={start}>
        <label for="mock-port" class="text-xs text-muted">Port</label>
        <input
          id="mock-port"
          type="text"
          inputmode="numeric"
          class="w-24 font-mono"
          bind:value={portText}
          oninput={() => (portError = null)}
          data-autofocus
          autocomplete="off"
          aria-invalid={error ? true : undefined}
        />
        <Button variant="primary" type="submit" icon="play" loading={busy} disabled={!collection} data-testid="mock-start">Start</Button>
        <span class="flex-1"></span>
        {@render help()}
      </form>
    {/if}

    <p class="text-xs text-muted" data-testid="mock-summary">
      {#if server}
        Listening on 127.0.0.1 only · serving {plural(exampleCount, 'saved example')} · {plural(server.requestCount, 'request')} answered
      {:else}
        Not running · {plural(exampleCount, 'saved example')} to serve
      {/if}
    </p>
    {#if exampleCount === 0}
      <p class="rounded border border-warning bg-warning-soft px-2 py-1.5 text-xs" data-testid="mock-no-examples">
        This collection has no saved examples yet, so every request gets a 404. Save a response as an example, or add one from a request's menu.
      </p>
    {/if}
    <InlineError message={error} />

    <section class="flex min-h-0 flex-col gap-1" aria-label="Request log">
      <div class="flex items-center gap-1">
        <h3 class="text-xs font-semibold text-muted">Requests</h3>
        <span class="flex-1"></span>
        <IconButton icon="trash" label="Clear log" disabled={log.length === 0} onclick={() => void mockServers.clearLog(collectionId)} />
      </div>
      <div class="max-h-80 min-h-24 overflow-auto rounded border border-border" data-testid="mock-log">
        {#if log.length === 0}
          <p class="px-3 py-6 text-center text-xs text-muted">{server ? 'No requests yet.' : 'Start the server to see the requests it answers.'}</p>
        {:else}
          <table class="w-full table-fixed text-xs">
            <thead class="sticky top-0 bg-surface text-left text-muted">
              <tr>
                <th class="w-16 px-2 py-1 font-normal">Time</th>
                <th class="w-16 px-2 py-1 font-normal">Method</th>
                <th class="px-2 py-1 font-normal">Path</th>
                <th class="w-56 px-2 py-1 font-normal">Example</th>
                <th class="w-14 px-2 py-1 text-right font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each log as entry (entry.seq)}
                <tr class="border-t border-border" data-testid="mock-log-row">
                  <td class="px-2 py-1 tabular-nums text-muted">{logTime(entry.at)}</td>
                  <td class="px-2 py-1 font-semibold" style="color: {methodColor(entry.method)}">{entry.method}</td>
                  <td class="truncate px-2 py-1 font-mono" title={entry.path}>{entry.path}</td>
                  <td class="truncate px-2 py-1">
                    {#if entry.match}
                      {@const m = entry.match}
                      <button
                        type="button"
                        class="max-w-full truncate text-left text-accent-text hover:underline"
                        title="Open the example “{m.name}” of “{m.requestName}”"
                        onclick={() => onopenexample(m.requestId, m.exampleIndex)}>{m.requestName} › {m.name}</button
                      >
                    {:else}
                      <span class="text-muted" title={entry.reason ?? ''}>no match</span>
                    {/if}
                  </td>
                  <td class="px-2 py-1 text-right font-semibold tabular-nums {tone(entry.status)}">{entry.status}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </section>
  </div>
</Dialog>

{#snippet help()}
  <InfoTip label="About mock servers">
    <span>The mock server answers with this collection's saved examples, so you can send requests before the real API exists. Point a request (or your <code>{'{{baseUrl}}'}</code>) at the base URL.</span>
    <span>A request matches an example by method and path. The scheme, host and a leading <code>{'{{variable}}'}</code> of the example's URL are ignored; <code>:id</code> and <code>{'{{id}}'}</code> path parts match anything, and an exact path wins over such a wildcard. Among several matches the first in the collection answers, unless the request picks one with the <code>x-mock-response-name</code> or <code>x-mock-response-code</code> header. No match gets a 404 that says why.</span>
    <span>Edits to the examples apply right away. The server listens on 127.0.0.1 only and stops when Slinger quits.</span>
  </InfoTip>
{/snippet}
