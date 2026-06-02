<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import PayloadViewer from './PayloadViewer.svelte'
  import RequestActiveTab from './RequestActiveTab.svelte'
  import { PAYLOAD_CONTENT_TYPE_OPTIONS, type PayloadContentType } from '../lib/payloadFormatters'
  import { resolveTemplateParts, type TemplatePart } from '../lib/requestDocument'
  import type {
    ActiveTab,
    HeaderDocument,
    RequestDocument,
    RequestParam,
    ResponseExample,
  } from '../lib/requestDocument'
  import type { ApiRequest, Collection, EnvironmentVariable, HttpResponseData } from '../tauri'

  type RequestTabItem = {
    id: string
    name: string
    method: string
    hasChanges: boolean
  }

  const HTTP_STATUS_CODES = [
    { code: 200, text: 'OK' },
    { code: 201, text: 'Created' },
    { code: 204, text: 'No Content' },
    { code: 301, text: 'Moved Permanently' },
    { code: 302, text: 'Found' },
    { code: 304, text: 'Not Modified' },
    { code: 400, text: 'Bad Request' },
    { code: 401, text: 'Unauthorized' },
    { code: 403, text: 'Forbidden' },
    { code: 404, text: 'Not Found' },
    { code: 408, text: 'Request Timeout' },
    { code: 429, text: 'Too Many Requests' },
    { code: 500, text: 'Internal Server Error' },
    { code: 501, text: 'Not Implemented' },
    { code: 502, text: 'Bad Gateway' },
    { code: 503, text: 'Service Unavailable' },
    { code: 504, text: 'Gateway Timeout' },
  ]
  const REQUEST_TABS: ActiveTab[] = [
    'Docs',
    'Params',
    'Authorization',
    'Headers',
    'Body',
    'Scripts',
    'Settings',
  ]
  const HTTP_METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']
  const HTTP_METHOD_CLASSES: Record<string, string> = {
    GET: 'text-[#16a34a]',
    POST: 'text-[#f59e0b]',
    PUT: 'text-[#0ea5e9]',
    PATCH: 'text-[#f97316]',
    DELETE: 'text-[#ef4444]',
    HEAD: 'text-[#64748b]',
    OPTIONS: 'text-[#8b5cf6]',
    CONNECT: 'text-[#0f766e]',
    TRACE: 'text-[#14b8a6]',
  }

  export let activeTab: ActiveTab
  export let bodyDraft: string
  export let bodyIsValid: boolean
  export let closeRequestTab: (requestId: string) => void | Promise<void>
  export let description: string
  export let handleBeautifyBody: () => void
  export let handleCreateRequestDraft: () => void | Promise<void>
  export let handleSaveRequest: () => Promise<void>
  export let handleSend: () => Promise<void>
  export let headers: HeaderDocument[]
  export let methodDraft: string
  export let orientation: 'vertical' | 'horizontal'
  export let openRequestTabs: RequestTabItem[]
  export let params: RequestParam[]
  export let requestContentType: PayloadContentType
  export let responseContentType: PayloadContentType
  export let responseExamples: ResponseExample[]
  export let responseStatusCode: string
  export let responseViewTab: 'headers' | 'body'
  export let requestHasChanges: boolean
  export let scripts: string
  export let selectedCollection: Collection | null
  export let selectedDocument: RequestDocument
  export let selectedRequest: ApiRequest | null
  export let selectedRequestId: string | null
  export let selectedResponse: ResponseExample | null
  export let selectedResponseIndex: number
  export let sendError: string | null
  export let sendResult: HttpResponseData | null
  export let sending: boolean
  export let savingRequest: boolean
  export let setActiveTab: (tab: ActiveTab) => void
  export let setBodyDraft: (value: string) => void
  export let setRequestContentType: (type: PayloadContentType) => void
  export let setResponseContentType: (type: PayloadContentType) => void
  export let setResponseStatusCode: (code: string) => void
  export let setResponseViewTab: (tab: 'headers' | 'body') => void
  export let setSelectedResponseIndex: (index: number) => void
  export let setSelectedRequestId: (id: string | null) => void
  export let setUrlDraft: (value: string) => void
  export let setRequestMethod: (method: string) => void
  export let environmentVariables: EnvironmentVariable[]
  export let setEnvironmentVariable: (key: string, value: string) => Promise<void>
  export let selectedEnvironmentId: string | null
  export let urlDraft: string

  let responseHeight = 260
  let responseWidth = 420
  let isResizingResponse = false
  let responseSplitRef: HTMLDivElement

  function payloadBodyToString(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  let urlParts: TemplatePart[] = []
  let hoveredEnvKey: string | null = null
  let hoveredEnvValue = ''
  let hoveredEnvResolved = false
  let hoverPopupTimeout: ReturnType<typeof setTimeout> | null = null

  function clearHoverPopupTimeout() {
    if (hoverPopupTimeout !== null) {
      clearTimeout(hoverPopupTimeout)
      hoverPopupTimeout = null
    }
  }

  function scheduleHoverPopupHide() {
    clearHoverPopupTimeout()
    hoverPopupTimeout = setTimeout(() => {
      hoveredEnvKey = null
    }, 120)
  }

  function handleVariableMouseEnter(part: TemplatePart) {
    if (!part.key) return
    clearHoverPopupTimeout()
    hoveredEnvKey = part.key
    hoveredEnvValue = part.value ?? ''
    hoveredEnvResolved = part.resolved
  }

  function handleVariableMouseLeave() {
    scheduleHoverPopupHide()
  }

  function handlePopupMouseEnter() {
    clearHoverPopupTimeout()
  }

  function handlePopupMouseLeave() {
    scheduleHoverPopupHide()
  }

  async function saveHoveredEnv() {
    if (!hoveredEnvKey) return
    await setEnvironmentVariable(hoveredEnvKey, hoveredEnvValue)
  }

  $: urlParts = resolveTemplateParts(urlDraft, environmentVariables)

  function handleRequestContentTypeChange(event: Event) {
    setRequestContentType(selectValue(event) as PayloadContentType)
  }

  function handleResponseContentTypeChange(event: Event) {
    setResponseContentType(selectValue(event) as PayloadContentType)
  }

  function handlePointerMove(event: PointerEvent) {
    if (!isResizingResponse || !responseSplitRef) return
    const rect = responseSplitRef.getBoundingClientRect()

    if (orientation === 'vertical') {
      const newHeight = rect.bottom - event.clientY
      const minHeight = 120
      const maxHeight = rect.height - 120

      responseHeight = Math.max(minHeight, Math.min(maxHeight, newHeight))
    } else {
      const newWidth = rect.right - event.clientX
      const minWidth = 200
      const maxWidth = rect.width - 200

      responseWidth = Math.max(minWidth, Math.min(maxWidth, newWidth))
    }
  }

  function stopResize() {
    isResizingResponse = false
  }

  function startResize(event: PointerEvent) {
    event.preventDefault()
    isResizingResponse = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  onMount(() => {
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  })

  onDestroy(() => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', stopResize)
    window.removeEventListener('pointercancel', stopResize)
  })
</script>

<section class="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
  <div class="flex h-9 items-end gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-alt)] px-4">
    {#each openRequestTabs as requestTab (requestTab.id)}
      <div
        class={`flex h-7 max-w-[280px] shrink-0 items-center gap-2 rounded-t pl-4 pr-2 text-left text-xs ${
          requestTab.id === selectedRequestId
            ? 'bg-[var(--surface)] text-[var(--text)]'
            : 'bg-transparent text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]'
        }`}
      >
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left"
          on:click={() => setSelectedRequestId(requestTab.id)}
        >
          <span class="mr-2 font-semibold">{requestTab.method}</span>
          {requestTab.name}
        </button>
        <button
          type="button"
          class={`request-tab-close ${requestTab.hasChanges ? 'dirty' : 'clean'}`}
          aria-label="Close request tab"
          title={requestTab.hasChanges ? 'Unsaved changes. Close request tab' : 'Close request tab'}
          on:click={() => closeRequestTab(requestTab.id)}
        >
          <span class="request-tab-dot" aria-hidden="true" />
          <span class="request-tab-x" aria-hidden="true">×</span>
        </button>
      </div>
    {/each}
    <button
      class="h-7 shrink-0 px-3 text-lg text-[var(--muted)] hover:text-[var(--text)]"
      type="button"
      title="New request"
      on:click={handleCreateRequestDraft}
    >
      +
    </button>
  </div>

  {#if selectedRequest}
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-10 items-center gap-2 border-b border-[var(--border)] px-4 text-sm">
        <span class="text-[var(--muted)]">{selectedCollection?.name}</span>
        <span class="text-[var(--muted)]">&gt;</span>
        <span class="font-semibold text-[var(--text)]">{selectedRequest.name}</span>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
          <select
            value={methodDraft}
            on:change={(event) => setRequestMethod(selectValue(event).toUpperCase())}
            class={`h-8 min-w-[108px] rounded border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-bold outline-none appearance-none ${HTTP_METHOD_CLASSES[methodDraft?.toUpperCase() ?? ''] ?? 'text-[var(--text)]'}`}
          >
            {#each HTTP_METHOD_OPTIONS as method}
              <option value={method}>{method}</option>
            {/each}
          </select>
          <div class="relative min-w-0 flex-1">
            <div class="absolute inset-0 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 py-0.5 font-mono text-sm leading-8 text-[var(--text)] whitespace-pre overflow-hidden" style="pointer-events: none;">
              {#each urlParts as part}
                {#if part.key}
                  <span
                    role="button"
                    tabindex="0"
                    class="inline-block"
                    style={part.resolved ? 'color: #60a5fa; pointer-events: auto; position: relative; z-index: 10;' : 'color: #f87171; pointer-events: auto; position: relative; z-index: 10;'}
                    title={part.resolved ? `Resolved value: ${part.value ?? ''}` : `Unresolved variable: ${part.key}`}
                    on:mouseover={() => handleVariableMouseEnter(part)}
                    on:mouseout={handleVariableMouseLeave}
                    on:focus={() => handleVariableMouseEnter(part)}
                    on:blur={handleVariableMouseLeave}
                  >
                    {part.text}
                  </span>
                {:else}
                  <span>{part.text}</span>
                {/if}
              {/each}
            </div>
            <input
              value={urlDraft}
              on:input={(event) => setUrlDraft(inputValue(event))}
              class="relative h-8 w-full rounded border border-transparent bg-transparent px-3 font-mono text-sm text-transparent caret-[var(--text)] outline-none"
            />
            {#if hoveredEnvKey}
              <div class="absolute left-0 top-full mt-1 z-20 min-w-[180px]">
                <div
                  class="rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm shadow-lg"
                  on:mouseenter={handlePopupMouseEnter}
                  on:mouseleave={handlePopupMouseLeave}
                >
                  <input
                    class="rounded border border-[var(--input-border)] bg-[var(--input)] px-2 py-2 text-sm text-[var(--text)] outline-none"
                    style="min-width: 180px; width: min-content; max-width: calc(100vw - 3rem);"
                    bind:value={hoveredEnvValue}
                    placeholder={selectedEnvironmentId ? 'Enter value' : 'Select an environment first'}
                    disabled={!selectedEnvironmentId}
                    on:blur={saveHoveredEnv}
                    on:keydown={(event) => event.key === 'Enter' && saveHoveredEnv()}
                  />
                </div>
              </div>
            {/if}
          </div>
          <div class="flex w-24 shrink-0 flex-col gap-1">
            <button
              class="secondary-button h-7 w-full text-xs"
              type="button"
              on:click={handleSaveRequest}
              disabled={!requestHasChanges || savingRequest}
              title="Save request (Ctrl+S)"
            >
              {savingRequest ? 'Saving' : 'Save'}
            </button>
            <button class="primary-button h-8 w-full" on:click={handleSend} disabled={sending}>{sending ? 'Sending' : 'Send'}</button>
          </div>
        </div>
        {#if sending}
          <div class="glow-strip mx-3 rounded-full">
            <div class="glow-slide" />
          </div>
        {/if}
      </div>

      <div class="flex h-10 items-center gap-6 border-b border-[var(--border)] px-4 text-sm text-[var(--muted)]">
        {#each REQUEST_TABS as tab}
          <button on:click={() => setActiveTab(tab)} class={`h-10 border-b-2 ${tab === activeTab ? 'border-[#f26b3a] font-semibold text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'}`}>
            {tab}
            {#if tab === 'Headers' && headers.length > 0}
              <span class="ml-1 text-[var(--muted)]">{headers.length}</span>
            {/if}
          </button>
        {/each}
      </div>

      {#if activeTab === 'Body'}
        <div class="flex h-10 items-center gap-4 overflow-x-auto border-b border-[var(--border)] px-4 text-sm text-[var(--muted)]">
          {#each ['none', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary', 'GraphQL'] as item}
            <div class="flex shrink-0 items-center gap-2">
              <span class={`h-3 w-3 rounded-full border ${item === (selectedDocument.body?.mode ?? 'raw') ? 'border-[#5797ff] bg-[#5797ff]' : 'border-[var(--border)]'}`} />
              {item}
            </div>
          {/each}
          <div class="ml-auto flex shrink-0 items-center gap-2">
            <select
              value={requestContentType}
              on:change={handleRequestContentTypeChange}
              class="select-field h-7 rounded px-2 text-xs outline-none focus:border-[#5a8fff]"
            >
              {#each PAYLOAD_CONTENT_TYPE_OPTIONS as option (option.value)}
                <option value={option.value}>
                  {option.label}
                </option>
              {/each}
            </select>
            <button class="secondary-button h-7" type="button" on:click={handleBeautifyBody}>
              Beautify
            </button>
          </div>
        </div>
      {/if}

      <div bind:this={responseSplitRef} class={`min-h-0 flex flex-1 ${orientation === 'vertical' ? 'flex-col' : 'flex-row'} bg-[var(--bg)]`}>
        <div class={`min-h-0 flex-1 overflow-auto ${orientation === 'vertical' ? 'border-b' : 'border-r'} border-[var(--border)] bg-[var(--bg)]`}>
          <RequestActiveTab
            {activeTab}
            {bodyDraft}
            {bodyIsValid}
            {description}
            {headers}
            {methodDraft}
            {params}
            {requestContentType}
            {responseExamples}
            {scripts}
            {selectedCollection}
            {selectedDocument}
            {selectedRequest}
            {setBodyDraft}
            {urlDraft}
          />
        </div>

        <div class={`${orientation === 'vertical' ? 'flex h-5 cursor-row-resize' : 'flex w-3 cursor-col-resize'} items-center justify-center bg-[var(--surface)] hover:bg-[var(--panel)]`} on:pointerdown={startResize}>
          <div class={`${orientation === 'vertical' ? 'flex h-1.5 w-12 items-center justify-between' : 'flex h-6 w-1 items-center justify-between'}`}>
            {#if orientation === 'vertical'}
              <span class="block h-0.5 w-3 rounded-full bg-[var(--muted)]" />
              <span class="text-xs text-[var(--muted)]">⇕</span>
              <span class="block h-0.5 w-3 rounded-full bg-[var(--muted)]" />
            {:else}
              <span class="block h-3 w-0.5 rounded-full bg-[var(--muted)]" />
              <span class="text-xs text-[var(--muted)]">⇆</span>
              <span class="block h-3 w-0.5 rounded-full bg-[var(--muted)]" />
            {/if}
          </div>
        </div>

        <div class="min-h-0 overflow-auto px-4 py-3" style={orientation === 'vertical' ? `height: ${responseHeight}px` : `width: ${responseWidth}px`}>
          {#if sendError}
            <pre class="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">{sendError}</pre>
          {:else if sendResult}
            <div class="space-y-3">
              <div class="flex h-10 items-center gap-4 border-b border-[var(--border)] pb-3 text-sm">
                <button
                  on:click={() => setResponseViewTab('headers')}
                  class={`h-8 rounded px-3 transition-colors ${
                    responseViewTab === 'headers'
                      ? 'bg-[var(--surface)] text-[var(--text)]'
                      : 'text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  Headers
                </button>
                <button
                  on:click={() => setResponseViewTab('body')}
                  class={`h-8 rounded px-3 transition-colors ${
                    responseViewTab === 'body'
                      ? 'bg-[var(--surface)] text-[var(--text)]'
                      : 'text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  Body
                </button>

                <div class="ml-auto flex items-center gap-3">
                  <span class="text-xs font-semibold text-[var(--muted)]">Status Code</span>
                  <select
                    value={responseStatusCode}
                    on:change={(event) => setResponseStatusCode(selectValue(event))}
                    class="select-field h-8 w-32 rounded px-2 text-xs outline-none focus:border-[#5a8fff]"
                  >
                    {#each HTTP_STATUS_CODES as status (status.code)}
                      <option value={String(status.code)}>
                        {status.code} {status.text}
                      </option>
                    {/each}
                  </select>
                </div>
              </div>

              {#if responseViewTab === 'headers'}
                <div class="space-y-3">
                  {#if sendResult.headers.length > 0}
                    <div class="grid grid-cols-[220px_1fr] gap-0 overflow-hidden rounded border border-[var(--border)] text-xs">
                      {#each sendResult.headers as header (`${header.key}-${header.value}`)}
                        <div class="contents">
                          <div class="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono font-semibold text-[var(--text)]">{header.key}</div>
                          <div class="break-all border-b border-[var(--border)] px-3 py-2 font-mono text-[var(--muted)]">{header.value}</div>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="flex h-20 items-center justify-center rounded border border-[var(--border)] text-sm text-[var(--muted)]">No headers</div>
                  {/if}
                </div>
              {:else}
                <div class="space-y-3">
                  <div class="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
                    <span class="text-xs font-semibold text-[var(--muted)]">Content Type</span>
                    <select
                      value={responseContentType}
                      on:change={handleResponseContentTypeChange}
                      class="select-field min-w-[140px] rounded px-2 py-1 text-xs outline-none focus:border-[#5a8fff]"
                    >
                      {#each PAYLOAD_CONTENT_TYPE_OPTIONS as option (option.value)}
                        <option value={option.value}>
                          {option.label}
                        </option>
                      {/each}
                    </select>
                  </div>
                  <PayloadViewer
                    value={payloadBodyToString(sendResult.body)}
                    contentType={responseContentType}
                    emptyText="No response body."
                  />
                </div>
              {/if}
            </div>
          {:else if responseExamples.length > 0}
            <div class="space-y-3">
              <div class="flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
                <div class="flex items-center gap-2 text-sm text-[var(--muted)]">
                  <span class="font-semibold text-[var(--text)]">Example</span>
                  <span class="text-[var(--muted)]">▼</span>
                </div>
                <select
                  value={selectedResponseIndex}
                  on:change={(event) => setSelectedResponseIndex(Number(selectValue(event)))}
                  class="select-field min-w-[180px] rounded px-3 py-2 text-sm outline-none focus:border-[#5a8fff]"
                >
                  {#each responseExamples as response, index (`${response.name ?? 'example'}-${index}`)}
                    <option value={index}>
                      {response.name ?? `Example ${index + 1}`} {response.status ? ` — ${response.status}` : ''}
                    </option>
                  {/each}
                </select>
                <select
                  value={responseContentType}
                  on:change={handleResponseContentTypeChange}
                  class="select-field min-w-[120px] rounded px-3 py-2 text-sm outline-none focus:border-[#5a8fff]"
                >
                  {#each PAYLOAD_CONTENT_TYPE_OPTIONS as option (option.value)}
                    <option value={option.value}>
                      {option.label}
                    </option>
                  {/each}
                </select>
              </div>

              <div class="space-y-2 rounded border border-[var(--border)] bg-[var(--panel)] p-4">
                <div class="flex flex-wrap items-center gap-3 text-sm">
                  <span class="font-semibold text-[var(--text)]">{selectedResponse?.name ?? 'Example'}</span>
                  <span class="text-[var(--muted)]">{selectedResponse?.status ?? 'Imported response'}</span>
                  {#if selectedResponse?.code}
                    <span class="rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted)]">{selectedResponse.code}</span>
                  {/if}
                </div>
                <PayloadViewer
                  value={selectedResponse?.body ?? ''}
                  contentType={responseContentType}
                  emptyText="No response body."
                />
              </div>
            </div>
          {:else}
            <div class="flex h-full items-center justify-center text-sm text-[var(--muted)]">Response body will appear here.</div>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <h2 class="text-lg font-semibold text-[var(--text)]">No request open</h2>
        <p class="mt-2 max-w-sm text-sm text-[var(--muted)]">Import the sample Postman collection or create a collection to begin building the request workspace.</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .request-tab-close {
    position: relative;
    display: inline-flex;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--muted);
    line-height: 1;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .request-tab-close:hover,
  .request-tab-close:focus-visible {
    background: rgba(148, 163, 184, 0.14);
    color: var(--text);
    outline: none;
  }

  .request-tab-dot,
  .request-tab-x {
    position: absolute;
    transition:
      opacity 0.15s ease,
      transform 0.15s ease;
  }

  .request-tab-dot {
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: #f26b3a;
    box-shadow:
      0 0 0 3px rgba(242, 107, 58, 0.16),
      0 0 13px rgba(242, 107, 58, 0.85);
  }

  .request-tab-x {
    font-size: 15px;
    font-weight: 600;
    transform: scale(0.75);
    opacity: 0;
  }

  .request-tab-close.clean .request-tab-dot {
    opacity: 0;
    transform: scale(0.4);
  }

  .request-tab-close.clean .request-tab-x,
  .request-tab-close.dirty:hover .request-tab-x,
  .request-tab-close.dirty:focus-visible .request-tab-x {
    opacity: 1;
    transform: scale(1);
  }

  .request-tab-close.dirty:hover .request-tab-dot,
  .request-tab-close.dirty:focus-visible .request-tab-dot {
    opacity: 0;
    transform: scale(0.4);
  }
</style>
