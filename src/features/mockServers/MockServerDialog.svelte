<script lang="ts">
  /**
   * A collection's mock server: start it on a port, copy its base URL, stop it, set its options (CORS, delay, start with
   * Slinger; editable before the start and while it runs), and watch the requests it answers. Clicking a logged request
   * shows its details under the log (MockRequestDetails). The server runs in the main process; state comes from the
   * `mockServers` store.
   */
  import { untrack } from 'svelte'
  import { MOCK_MAX_DELAY_MS } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { logTime, parseDelay, parsePort } from '../../lib/mockServers'
  import { statusTone } from '../../lib/response'
  import { methodColor } from '../requests/method'
  import MockRequestDetails from './MockRequestDetails.svelte'
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
  const options = $derived(mockServers.optionsFor(collectionId))
  const startWithSlinger = $derived(mockServers.settingsFor(collectionId).startWithSlinger)
  const title = $derived(collection?.name ?? server?.collectionName ?? 'Collection in another workspace')

  let portText = $state(untrack(() => String(mockServers.suggestedPort(collectionId))))
  let portError = $state<string | null>(null)
  let delayText = $state(untrack(() => String(mockServers.optionsFor(collectionId).delayMs)))
  let delayError = $state<string | null>(null)
  const error = $derived(portError ?? delayError ?? mockServers.errors[collectionId] ?? null)

  // The delay field follows changes made elsewhere (another window call, a restart) unless it holds an unsaved error.
  $effect(() => {
    const ms = options.delayMs
    untrack(() => {
      if (!delayError && parseDelay(delayText).delayMs !== ms) delayText = String(ms)
    })
  })

  let selectedSeq = $state<number | null>(null)
  const selected = $derived(selectedSeq === null ? null : (log.find((e) => e.seq === selectedSeq) ?? null))

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

  function setCors(any: boolean) {
    void mockServers.setOptions(collectionId, { ...options, cors: any ? 'any' : 'local' })
  }

  function commitDelay() {
    const parsed = parseDelay(delayText)
    if (parsed.delayMs === null) {
      delayError = parsed.error
      return
    }
    delayError = null
    delayText = String(parsed.delayMs)
    if (parsed.delayMs !== options.delayMs) void mockServers.setOptions(collectionId, { ...options, delayMs: parsed.delayMs })
  }

  function select(seq: number) {
    selectedSeq = selectedSeq === seq ? null : seq
  }

  function rowKey(e: KeyboardEvent, seq: number) {
    const row = e.currentTarget as HTMLElement
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select(seq)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null
      if (!next) return
      e.preventDefault()
      next.focus()
      const nextSeq = Number(next.dataset.seq)
      if (selectedSeq !== null && Number.isFinite(nextSeq)) selectedSeq = nextSeq
    }
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const tone = (status: number) => ({ success: 'text-success', info: 'text-fg', warning: 'text-warning', danger: 'text-danger' })[statusTone(status)]
</script>

<Dialog title="Mock server · {title}" size="lg" {onclose}>
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
          aria-invalid={portError || mockServers.errors[collectionId] ? true : undefined}
        />
        <Button variant="primary" type="submit" icon="play" loading={busy} disabled={!collection} data-testid="mock-start">Start</Button>
        <span class="flex-1"></span>
        {@render help()}
      </form>
    {/if}

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs" role="group" aria-label="Mock server options" data-testid="mock-options">
      <span class="flex items-center gap-1">
        <label class="flex items-center gap-1.5">
          <input type="checkbox" checked={options.cors === 'any'} onchange={(e) => setCors(e.currentTarget.checked)} data-testid="mock-cors" />
          Allow any website (CORS)
        </label>
        <InfoTip label="About CORS">
          <span>Web pages may only read the mock's answers when it allows them (CORS). Off: only pages served from this computer (localhost, 127.0.0.1) can, which is what a web app in development usually needs.</span>
          <span>On: every website may call the mock and read its answers, including any site you visit while it runs. Turn it on only when a page hosted elsewhere needs it, and only with examples that hold nothing private.</span>
          <span>Programs other than browsers (Slinger, curl, your backend) are not affected by this setting.</span>
        </InfoTip>
      </span>
      <span class="flex items-center gap-1">
        <label for="mock-delay">Delay (ms)</label>
        <input
          id="mock-delay"
          type="number"
          min="0"
          max={MOCK_MAX_DELAY_MS}
          step="100"
          class="w-24 font-mono"
          value={delayText}
          oninput={(e) => {
            delayText = e.currentTarget.value
            delayError = null
          }}
          onchange={commitDelay}
          onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), commitDelay())}
          aria-invalid={delayError ? true : undefined}
          data-testid="mock-delay"
        />
        <InfoTip label="About the delay">
          <span>Every answer waits this long (0 to {MOCK_MAX_DELAY_MS} ms), to see how your app shows loading states or handles slow servers. Applies to the next request, also while the server runs.</span>
        </InfoTip>
      </span>
      <span class="flex items-center gap-1">
        <label class="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={startWithSlinger}
            onchange={(e) => mockServers.setStartWithSlinger(collectionId, e.currentTarget.checked)}
            data-testid="mock-start-with-slinger"
          />
          Start again when Slinger starts
        </label>
        <InfoTip label="About starting with Slinger">
          <span>When this mock server is running as Slinger quits, it starts again on the same port the next time Slinger starts, even if its collection is in another workspace. Stopping it yourself ends that.</span>
        </InfoTip>
      </span>
    </div>

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
        {#if log.length > 0}
          <span class="text-xs text-muted">· click one to see its details</span>
        {/if}
        <span class="flex-1"></span>
        <IconButton icon="trash" label="Clear log" disabled={log.length === 0} onclick={() => void mockServers.clearLog(collectionId)} />
      </div>
      <div class="max-h-64 min-h-24 overflow-auto rounded border border-border" data-testid="mock-log">
        {#if log.length === 0}
          <p class="px-3 py-6 text-center text-xs text-muted">{server ? 'No requests yet.' : 'Start the server to see the requests it answers.'}</p>
        {:else}
          <table class="w-full table-fixed text-xs" role="grid" aria-label="Requests">
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
                {@const isSelected = entry.seq === selectedSeq}
                <tr
                  class="cursor-pointer border-t border-border hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                  class:bg-accent-soft={isSelected}
                  tabindex="0"
                  aria-selected={isSelected}
                  data-seq={entry.seq}
                  data-testid="mock-log-row"
                  onclick={() => select(entry.seq)}
                  onkeydown={(e) => rowKey(e, entry.seq)}
                >
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
                        onclick={(e) => {
                          e.stopPropagation()
                          onopenexample(m.requestId, m.exampleIndex)
                        }}>{m.requestName} › {m.name}</button
                      >
                    {:else if entry.kind === 'preflight'}
                      <span class="text-muted">CORS preflight</span>
                    {:else if entry.kind === 'refused'}
                      <span class="text-muted" title={entry.reason ?? ''}>refused</span>
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

    {#if selected}
      <MockRequestDetails entry={selected} {onopenexample} />
    {/if}
  </div>
</Dialog>

{#snippet help()}
  <InfoTip label="About mock servers">
    <span>The mock server answers with this collection's saved examples, so you can send requests before the real API exists. Point a request (or your <code>{'{{baseUrl}}'}</code>) at the base URL.</span>
    <span>A request matches an example by method and path. The scheme, host and a leading <code>{'{{variable}}'}</code> of the example's URL are ignored; <code>:id</code> and <code>{'{{id}}'}</code> path parts match anything, and an exact path wins over such a wildcard. Then an example whose saved query parameters the request has wins, then one whose saved request body equals the request's. Among several matches the first in the collection answers, unless the request picks one with the <code>x-mock-response-name</code> or <code>x-mock-response-code</code> header. No match gets a 404 that says why.</span>
    <span>Edits to the examples apply right away. The server listens on 127.0.0.1 only; it stops when Slinger quits and, unless you switch that off, starts again with Slinger.</span>
  </InfoTip>
{/snippet}
