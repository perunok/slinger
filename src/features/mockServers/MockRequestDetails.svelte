<script lang="ts">
  /**
   * The request inspector under a mock server's log: what the client sent (request line, query parameters, headers, body)
   * and what the mock answered (status, the example or why none, headers, delay, duration). Credential headers are shown
   * shortened (lib/mockServers.ts `displayHeaderValue`), with no way to reveal them.
   */
  import type { MockServerLogEntry } from '../../../shared/types'
  import { MOCK_LOG_BODY_LIMIT } from '../../../shared/types'
  import { displayHeaderValue, isCredentialHeader, pathOnly, prettyBody, queryParams } from '../../lib/mockServers'
  import { formatBytes, formatDuration, statusTone } from '../../lib/response'
  import { methodColor } from '../requests/method'

  interface Props {
    entry: MockServerLogEntry
    /** Opens the example that answered. */
    onopenexample: (requestId: string, exampleIndex: number) => void
  }
  let { entry, onopenexample }: Props = $props()

  const params = $derived(queryParams(entry.path))
  const header = (name: string) => entry.request.headers.find(([k]) => k === name)?.[1]
  const body = $derived(entry.request.body !== null && entry.request.bodyEncoding === null ? prettyBody(entry.request.body) : null)
  const tone = $derived(({ success: 'text-success', info: 'text-fg', warning: 'text-warning', danger: 'text-danger' })[statusTone(entry.status)])
</script>

{#snippet headerTable(rows: Array<[string, string]>, label: string, testid: string)}
  {#if rows.length === 0}
    <p class="text-muted">None</p>
  {:else}
    <table class="w-full table-fixed" aria-label={label} data-testid={testid}>
      <tbody>
        {#each rows as [name, value], i (i)}
          <tr class="align-top">
            <th scope="row" class="w-2/5 py-0.5 pr-2 text-left font-mono font-normal break-all text-muted">{name}</th>
            <td class="py-0.5 font-mono break-all" class:text-muted={isCredentialHeader(name)}>{displayHeaderValue(name, value)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/snippet}

<section class="grid gap-3 rounded border border-border p-2 text-xs sm:grid-cols-2" aria-label="Request details" data-testid="mock-request-details">
  <div class="flex min-w-0 flex-col gap-2">
    <h3 class="font-semibold text-muted">Request</h3>
    <p class="font-mono break-all" data-testid="mock-request-line">
      <span class="font-semibold" style="color: {methodColor(entry.method)}">{entry.method}</span>
      {pathOnly(entry.path)}{#if params.length > 0}<span class="text-muted">{entry.path.slice(entry.path.indexOf('?'))}</span>{/if}
    </p>

    {#if params.length > 0}
      <div class="flex flex-col gap-1">
        <h4 class="text-muted">Query parameters</h4>
        <table class="w-full table-fixed" aria-label="Query parameters" data-testid="mock-request-query">
          <tbody>
            {#each params as [name, value], i (i)}
              <tr class="align-top">
                <th scope="row" class="w-2/5 py-0.5 pr-2 text-left font-mono font-normal break-all text-muted">{name}</th>
                <td class="py-0.5 font-mono break-all">{value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div class="flex flex-col gap-1">
      <h4 class="text-muted">Headers</h4>
      {@render headerTable(entry.request.headers, 'Request headers', 'mock-request-headers')}
    </div>

    <div class="flex flex-col gap-1">
      <h4 class="text-muted">Body</h4>
      {#if entry.request.body === null}
        <p class="text-muted">No body</p>
      {:else}
        {#if entry.request.bodyEncoding === 'base64'}
          <p class="text-muted" data-testid="mock-request-binary">Binary body ({formatBytes(entry.request.bodyBytes)}), shown as base64.</p>
        {/if}
        {#if entry.request.truncated}
          <p class="text-muted" data-testid="mock-request-truncated">
            Truncated: the log keeps the first {formatBytes(MOCK_LOG_BODY_LIMIT)} of {formatBytes(entry.request.bodyBytes)}.
          </p>
        {/if}
        <pre class="max-h-48 overflow-auto rounded border border-border bg-raised px-2 py-1 font-mono break-all whitespace-pre-wrap" data-testid="mock-request-body">{body ? body.text : entry.request.body}</pre>
      {/if}
    </div>
  </div>

  <div class="flex min-w-0 flex-col gap-2">
    <h3 class="font-semibold text-muted">Answer</h3>
    <p data-testid="mock-response-status">
      <span class="font-semibold tabular-nums {tone}">{entry.status}</span>
      {entry.response.statusText}
    </p>
    {#if entry.kind === 'example' && entry.match}
      {@const m = entry.match}
      <p>
        From the example
        <button
          type="button"
          class="text-left text-accent-text hover:underline"
          title="Open the example “{m.name}” of “{m.requestName}”"
          onclick={() => onopenexample(m.requestId, m.exampleIndex)}>{m.requestName} › {m.name}</button
        >
      </p>
    {:else if entry.kind === 'preflight'}
      <p data-testid="mock-request-reason">
        A CORS preflight: before calling the mock, the browser asked whether a page from <code>{header('origin') ?? 'a website'}</code> may send
        {header('access-control-request-method') ?? 'this request'}. The mock server answered it itself (no example involved).
      </p>
    {:else}
      <p data-testid="mock-request-reason">{entry.reason ?? (entry.kind === 'refused' ? 'Refused.' : 'No example matched.')}</p>
    {/if}
    <p class="text-muted" data-testid="mock-response-timing">
      Delay {entry.response.delayMs > 0 ? formatDuration(entry.response.delayMs) : 'none'} · took {formatDuration(entry.durationMs)}
    </p>
    <div class="flex flex-col gap-1">
      <h4 class="text-muted">Headers</h4>
      {@render headerTable(entry.response.headers, 'Response headers', 'mock-response-headers')}
    </div>
  </div>
</section>
