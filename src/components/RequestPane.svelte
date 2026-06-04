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
  import type { RequestAuthDocument } from '../lib/authDocument'
  import type { ApiRequest, Collection, EnvironmentVariable, HttpResponseData } from '../tauri'

  type RequestTabItem = {
    id: string
    name: string
    method: string
    hasChanges: boolean
  }

  const HTTP_STATUS_TEXT: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  }
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
  const REQUEST_TAB_WIDTH = 176
  const REQUEST_TAB_GAP = 4

  export let activeTab: ActiveTab
  export let bodyDraft: string
  export let bodyIsValid: boolean
  export let closeAllRequestTabs: () => void | Promise<void>
  export let closeRequestTab: (requestId: string) => void | Promise<void>
  export let description: string
  export let handleBeautifyBody: () => void
  export let handleCreateRequestDraft: () => void | Promise<void>
  export let handleSaveRequest: () => Promise<void>
  export let handleSaveResponse: () => Promise<void>
  export let handleSend: () => Promise<void>
  export let headers: HeaderDocument[]
  export let methodDraft: string
  export let orientation: 'vertical' | 'horizontal'
  export let openRequestTabs: RequestTabItem[]
  export let params: RequestParam[]
  export let requestContentType: PayloadContentType
  export let responseContentType: PayloadContentType
  export let responseViewTab: 'headers' | 'body'
  export let requestHasChanges: boolean
  export let scripts: string
  export let selectedCollection: Collection | null
  export let selectedDocument: RequestDocument
  export let selectedRequest: ApiRequest | null
  export let selectedRequestId: string | null
  export let selectedResponse: ResponseExample | null
  export let sendError: string | null
  export let sendResult: HttpResponseData | null
  export let sending: boolean
  export let savingRequest: boolean
  export let savingResponse: boolean
  export let setActiveTab: (tab: ActiveTab) => void
  export let setAuth: (auth: RequestAuthDocument | null) => void
  export let setBodyDraft: (value: string) => void
  export let setHeaders: (headers: HeaderDocument[]) => void
  export let setRequestContentType: (type: PayloadContentType) => void
  export let setResponseViewTab: (tab: 'headers' | 'body') => void
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
  let tabListRef: HTMLDivElement
  let tabListWidth = 0
  let tabStripResizeObserver: ResizeObserver | null = null
  let tabContextMenu: { x: number; y: number } | null = null
  let overflowMenuOpen = false

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

  function contentTypeHeaderValue(headers: Array<{ key?: string; value?: string }>): string | null {
    const header = headers.find((item) => item.key?.toLowerCase() === 'content-type')
    return header?.value?.trim() || null
  }

  function formatResponseDuration(durationMs: number | null | undefined): string {
    if (durationMs === null || durationMs === undefined) return ''
    if (durationMs < 1000) return `${Math.round(durationMs)} ms`

    const seconds = durationMs / 1000
    return `${seconds.toFixed(seconds < 10 ? 2 : 1).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')} s`
  }

  let urlParts: TemplatePart[] = []
  let hoveredEnvKey: string | null = null
  let hoveredEnvValue = ''
  let hoveredEnvResolved = false
  let hoveredVariableSource: TemplatePart['source'] | null = null
  let hoverPopupTimeout: ReturnType<typeof setTimeout> | null = null

  function clearHoverPopupTimeout() {
    if (hoverPopupTimeout !== null) {
      clearTimeout(hoverPopupTimeout)
      hoverPopupTimeout = null
    }
  }

  function variablePartStyle(part: TemplatePart): string {
    const color =
      part.source === 'builtin'
        ? 'var(--variable-builtin)'
        : part.resolved
          ? 'var(--variable-env)'
          : 'var(--variable-unresolved)'

    return `color: ${color}; pointer-events: auto; position: relative; z-index: 10;`
  }

  function variablePartTitle(part: TemplatePart): string {
    if (part.source === 'builtin') return `Built-in value: ${part.value ?? ''}`
    return part.resolved ? `Resolved value: ${part.value ?? ''}` : `Unresolved variable: ${part.key}`
  }

  function scheduleHoverPopupHide() {
    clearHoverPopupTimeout()
    hoverPopupTimeout = setTimeout(() => {
      hoveredEnvKey = null
      hoveredVariableSource = null
    }, 120)
  }

  function handleVariableMouseEnter(part: TemplatePart) {
    if (!part.key) return
    clearHoverPopupTimeout()
    hoveredEnvKey = part.key
    hoveredEnvValue = part.value ?? ''
    hoveredEnvResolved = part.resolved
    hoveredVariableSource = part.source ?? null
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
    if (!hoveredEnvKey || hoveredVariableSource === 'builtin') return
    await setEnvironmentVariable(hoveredEnvKey, hoveredEnvValue)
  }

  $: urlParts = resolveTemplateParts(urlDraft, environmentVariables)

  function handleRequestContentTypeChange(event: Event) {
    setRequestContentType(selectValue(event) as PayloadContentType)
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

  function calculateVisibleRequestTabCount(listWidth: number, requestTabCount: number): number {
    if (!listWidth) return requestTabCount
    if (requestTabCount === 0) return 0

    const visibleSlots = Math.floor((listWidth + REQUEST_TAB_GAP) / (REQUEST_TAB_WIDTH + REQUEST_TAB_GAP))
    return Math.max(1, Math.min(requestTabCount, visibleSlots))
  }

  function updateTabListWidth() {
    tabListWidth = tabListRef?.clientWidth ?? 0
  }

  function openTabContextMenu(event: MouseEvent) {
    if (openRequestTabs.length === 0) return

    event.preventDefault()
    tabContextMenu = {
      x: event.clientX,
      y: event.clientY,
    }
  }

  function closeTabContextMenu() {
    tabContextMenu = null
  }

  function closeOverflowMenu() {
    overflowMenuOpen = false
  }

  async function handleCloseAllTabs() {
    closeTabContextMenu()
    await closeAllRequestTabs()
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      closeTabContextMenu()
      closeOverflowMenu()
    }
  }

  function handleWindowClick() {
    closeTabContextMenu()
    closeOverflowMenu()
  }

  function selectOverflowRequestTab(requestId: string) {
    closeOverflowMenu()
    setSelectedRequestId(requestId)
  }

  async function closeOverflowRequestTab(requestId: string) {
    closeOverflowMenu()
    await closeRequestTab(requestId)
  }

  $: visibleRequestTabCount = calculateVisibleRequestTabCount(tabListWidth, openRequestTabs.length)
  $: visibleRequestTabs = openRequestTabs.slice(0, visibleRequestTabCount)
  $: overflowRequestTabs = openRequestTabs.slice(visibleRequestTabCount)
  $: overflowHasSelection = overflowRequestTabs.some((requestTab) => requestTab.id === selectedRequestId)
  $: responsePanelBody = sendResult
    ? payloadBodyToString(sendResult.body)
    : selectedResponse
      ? payloadBodyToString(selectedResponse.body ?? '')
      : ''
  $: responsePanelHeaders = sendResult?.headers ??
    (selectedResponse && Array.isArray(selectedResponse.header) ? selectedResponse.header : [])
  $: responsePanelStatusCode = sendResult?.status ?? selectedResponse?.code ?? null
  $: responsePanelStatusText =
    sendResult?.status_text ||
    selectedResponse?.status ||
    (responsePanelStatusCode ? HTTP_STATUS_TEXT[responsePanelStatusCode] : '') ||
    ''
  $: responsePanelStatus = responsePanelStatusCode
    ? `${responsePanelStatusCode} ${responsePanelStatusText}`.trim()
    : responsePanelStatusText || 'Status'
  $: responseContentTypeLabel =
    PAYLOAD_CONTENT_TYPE_OPTIONS.find((option) => option.value === responseContentType)?.label ??
    responseContentType.toUpperCase()
  $: responsePanelContentType = contentTypeHeaderValue(responsePanelHeaders) ?? responseContentTypeLabel
  $: responsePanelDuration = formatResponseDuration(sendResult?.duration_ms)
  $: hasResponsePanel = Boolean(sendResult || selectedResponse)
  $: if (overflowRequestTabs.length === 0) {
    overflowMenuOpen = false
  }

  onMount(() => {
    updateTabListWidth()
    if (typeof ResizeObserver !== 'undefined') {
      tabStripResizeObserver = new ResizeObserver(updateTabListWidth)
      if (tabListRef) tabStripResizeObserver.observe(tabListRef)
    } else {
      window.addEventListener('resize', updateTabListWidth)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('click', handleWindowClick)
    window.addEventListener('keydown', handleWindowKeydown)
  })

  onDestroy(() => {
    tabStripResizeObserver?.disconnect()
    window.removeEventListener('resize', updateTabListWidth)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', stopResize)
    window.removeEventListener('pointercancel', stopResize)
    window.removeEventListener('click', handleWindowClick)
    window.removeEventListener('keydown', handleWindowKeydown)
  })
</script>

<section class="relative flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
  <div
    class="flex h-9 items-end gap-1 overflow-hidden border-b border-[var(--border)] bg-[var(--bg-alt)] px-4"
    role="presentation"
    on:contextmenu={openTabContextMenu}
  >
    <div bind:this={tabListRef} class="flex min-w-0 flex-1 items-end gap-1 overflow-hidden">
      {#each visibleRequestTabs as requestTab (requestTab.id)}
        <div
          class={`flex h-7 w-44 shrink-0 items-center gap-2 rounded-t pl-4 pr-2 text-left text-xs ${
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
    </div>
    {#if overflowRequestTabs.length > 0}
      <button
        class={`request-tab-overflow-trigger ${overflowHasSelection ? 'selected' : ''}`}
        type="button"
        title="More request tabs"
        aria-label={`${overflowRequestTabs.length} more request tabs`}
        on:click|stopPropagation={() => (overflowMenuOpen = !overflowMenuOpen)}
      >
        <span aria-hidden="true">+{overflowRequestTabs.length}</span>
        <span class="request-tab-overflow-caret" aria-hidden="true">v</span>
      </button>
    {/if}
    <button
      class="h-7 w-8 shrink-0 text-lg text-[var(--muted)] hover:text-[var(--text)]"
      type="button"
      title="New request"
      on:click={handleCreateRequestDraft}
    >
      +
    </button>
  </div>
  {#if overflowMenuOpen}
    <div class="request-tab-overflow-menu">
      {#each overflowRequestTabs as requestTab (requestTab.id)}
        <div
          class={`request-tab-overflow-item ${
            requestTab.id === selectedRequestId ? 'selected' : ''
          }`}
        >
          <button
            type="button"
            class="request-tab-overflow-select"
            on:click={() => selectOverflowRequestTab(requestTab.id)}
          >
            <span class="request-tab-overflow-method">{requestTab.method}</span>
            <span class="request-tab-overflow-name">{requestTab.name}</span>
          </button>
          <button
            type="button"
            class={`request-tab-close ${requestTab.hasChanges ? 'dirty' : 'clean'}`}
            aria-label="Close request tab"
            title={requestTab.hasChanges ? 'Unsaved changes. Close request tab' : 'Close request tab'}
            on:click={() => closeOverflowRequestTab(requestTab.id)}
          >
            <span class="request-tab-dot" aria-hidden="true" />
            <span class="request-tab-x" aria-hidden="true">×</span>
          </button>
        </div>
      {/each}
    </div>
  {/if}
  {#if tabContextMenu}
    <div
      class="request-tab-context-menu"
      role="menu"
      style={`left: ${tabContextMenu.x}px; top: ${tabContextMenu.y}px;`}
    >
      <button
        type="button"
        role="menuitem"
        on:click={handleCloseAllTabs}
      >
        Close all
      </button>
    </div>
  {/if}

  {#if selectedRequest}
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-10 items-center gap-2 border-b border-[var(--border)] px-4 text-sm">
        <span class="text-[var(--muted)]">{selectedCollection?.name}</span>
        <svg class="h-3 w-3 text-[var(--muted)] opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6"/>
        </svg>
        <span class="font-semibold text-[var(--text)]">{selectedRequest.name}</span>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
          <div class="relative flex items-center">
            <select
              value={methodDraft}
              on:change={(event) => setRequestMethod(selectValue(event).toUpperCase())}
              class={`h-8 min-w-[108px] rounded border border-[var(--border)] bg-[var(--surface)] pl-3 pr-8 text-sm font-bold outline-none appearance-none ${HTTP_METHOD_CLASSES[methodDraft?.toUpperCase() ?? ''] ?? 'text-[var(--text)]'}`}
            >
              {#each HTTP_METHOD_OPTIONS as method}
                <option value={method}>{method}</option>
              {/each}
            </select>
            <div class="pointer-events-none absolute right-2.5 text-[var(--muted)]">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6"/>
              </svg>
            </div>
          </div>
          <div class="relative min-w-0 flex-1">
            <div class="absolute inset-0 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 py-0.5 font-mono text-sm leading-8 text-[var(--text)] whitespace-pre overflow-hidden" style="pointer-events: none;">
              {#each urlParts as part}
                {#if part.key}
                  <span
                    role="button"
                    tabindex="0"
                    class="inline-block"
                    style={variablePartStyle(part)}
                    title={variablePartTitle(part)}
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
                  {#if hoveredVariableSource === 'builtin'}
                    <div class="grid min-w-[180px] gap-1">
                      <div class="font-mono text-xs" style="color: var(--variable-builtin);">{'{{'}{hoveredEnvKey}{'}}'}</div>
                      <div class="break-all text-xs text-[var(--muted)]">{hoveredEnvValue}</div>
                    </div>
                  {:else}
                    <input
                      class="rounded border border-[var(--input-border)] bg-[var(--input)] px-2 py-2 text-sm text-[var(--text)] outline-none"
                      style="min-width: 180px; width: min-content; max-width: calc(100vw - 3rem);"
                      bind:value={hoveredEnvValue}
                      placeholder={selectedEnvironmentId ? 'Enter value' : 'Select an environment first'}
                      disabled={!selectedEnvironmentId}
                      on:blur={saveHoveredEnv}
                      on:keydown={(event) => event.key === 'Enter' && saveHoveredEnv()}
                    />
                  {/if}
                </div>
              </div>
            {/if}
          </div>
          <div class="flex w-24 shrink-0 flex-col gap-1">
            <!-- <button
              class="secondary-button h-7 w-full text-xs"
              type="button"
              on:click={handleSaveRequest}
              disabled={!requestHasChanges || savingRequest}
              title="Save request (Ctrl+S)"
            >
              {savingRequest ? 'Saving' : 'Save'}
            </button> -->
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
            <div class="relative flex items-center">
              <select
                value={requestContentType}
                on:change={handleRequestContentTypeChange}
                class="select-field h-7 rounded pl-2 pr-6 text-xs outline-none focus:border-[#5a8fff] appearance-none"
              >
                {#each PAYLOAD_CONTENT_TYPE_OPTIONS as option (option.value)}
                  <option value={option.value}>
                    {option.label}
                  </option>
                {/each}
              </select>
              <div class="pointer-events-none absolute right-1.5 text-[var(--muted)]">
                <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m6 9 6 6 6-6"/>
                </svg>
              </div>
            </div>
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
            {environmentVariables}
            {methodDraft}
            {params}
            {requestContentType}
            {scripts}
            {selectedCollection}
            {selectedDocument}
            {selectedRequest}
            {setAuth}
            {setBodyDraft}
            {setHeaders}
            {urlDraft}
          />
        </div>

        <div class={`${orientation === 'vertical' ? 'flex h-5 cursor-row-resize' : 'flex w-3 cursor-col-resize'} items-center justify-center bg-[var(--surface)] hover:bg-[var(--panel)]`} on:pointerdown={startResize}>
          <div class={`${orientation === 'vertical' ? 'flex h-1.5 w-12 items-center justify-between' : 'flex h-6 w-1 items-center justify-between'}`}>
            {#if orientation === 'vertical'}
              <div class="flex flex-col gap-0.5 items-center">
                <div class="h-0.5 w-4 rounded-full bg-[var(--muted)] opacity-30"></div>
                <div class="h-0.5 w-4 rounded-full bg-[var(--muted)] opacity-50"></div>
                <div class="h-0.5 w-4 rounded-full bg-[var(--muted)] opacity-30"></div>
              </div>
            {:else}
              <div class="flex gap-0.5 items-center">
                <div class="w-0.5 h-4 rounded-full bg-[var(--muted)] opacity-30"></div>
                <div class="w-0.5 h-4 rounded-full bg-[var(--muted)] opacity-50"></div>
                <div class="w-0.5 h-4 rounded-full bg-[var(--muted)] opacity-30"></div>
              </div>
            {/if}
          </div>
        </div>

        <div
          class="flex min-h-0 flex-col"
          style={orientation === 'vertical' ? `height: ${responseHeight}px` : `width: ${responseWidth}px`}
        >
          {#if sendError}
            <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
              <pre class="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">{sendError}</pre>
            </div>
          {:else if hasResponsePanel}
            <div class="flex h-12 shrink-0 items-center gap-4 border-b border-[var(--border)] px-4 text-sm">
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

              <div class="ml-auto flex min-w-0 items-center gap-2">
                {#if sendResult}
                  <button
                    class="secondary-button h-7 shrink-0 px-2 text-xs"
                    type="button"
                    on:click={handleSaveResponse}
                    disabled={savingResponse}
                    title="Save response"
                  >
                    {savingResponse ? 'Saving' : 'Save'}
                  </button>
                {/if}
                <span class="max-w-[11rem] truncate rounded bg-[var(--surface)] px-2 py-1 text-xs font-semibold text-[var(--text)]">
                  {responsePanelStatus}
                </span>
                {#if responsePanelDuration}
                  <span class="shrink-0 rounded bg-[var(--surface)] px-2 py-1 text-xs font-semibold text-[var(--muted)]">
                    {responsePanelDuration}
                  </span>
                {/if}
                <span
                  class="max-w-[14rem] truncate rounded bg-[var(--surface)] px-2 py-1 text-xs font-semibold text-[var(--muted)]"
                  title={responsePanelContentType}
                >
                  {responsePanelContentType}
                </span>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
              {#if responseViewTab === 'headers'}
                <div class="space-y-3">
                  {#if responsePanelHeaders.length > 0}
                    <div class="grid grid-cols-[220px_1fr] gap-0 overflow-hidden rounded border border-[var(--border)] text-xs">
                      {#each responsePanelHeaders as header (`${header.key}-${header.value}`)}
                        <div class="contents">
                          <div class="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono font-semibold text-[var(--text)]">{header.key ?? ''}</div>
                          <div class="break-all border-b border-[var(--border)] px-3 py-2 font-mono text-[var(--muted)]">{header.value ?? ''}</div>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="flex h-20 items-center justify-center rounded border border-[var(--border)] text-sm text-[var(--muted)]">No headers</div>
                  {/if}
                </div>
              {:else}
                <PayloadViewer
                  value={responsePanelBody}
                  contentType={responseContentType}
                  emptyText="No response body."
                  wrap
                />
              {/if}
            </div>
          {:else}
            <div class="flex min-h-0 flex-1 items-center justify-center px-4 py-3 text-sm text-[var(--muted)]">Response body will appear here.</div>
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

  .request-tab-context-menu {
    position: fixed;
    z-index: 70;
    min-width: 8rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-alt);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.32);
    padding: 0.25rem;
  }

  .request-tab-context-menu button {
    display: flex;
    width: 100%;
    align-items: center;
    border-radius: 0.25rem;
    padding: 0.45rem 0.6rem;
    color: var(--text);
    font-size: 0.8125rem;
    text-align: left;
  }

  .request-tab-context-menu button:hover,
  .request-tab-context-menu button:focus-visible {
    background: var(--surface);
    outline: none;
  }

  .request-tab-overflow-trigger {
    position: relative;
    display: inline-flex;
    width: 38px;
    height: 26px;
    flex: 0 0 38px;
    align-items: center;
    gap: 2px;
    justify-content: center;
    align-self: center;
    border-radius: 0.25rem;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1;
  }

  .request-tab-overflow-trigger:hover,
  .request-tab-overflow-trigger:focus-visible,
  .request-tab-overflow-trigger.selected {
    background: var(--panel);
    color: var(--text);
    outline: none;
  }

  .request-tab-overflow-caret {
    display: inline-flex;
    width: 0.625rem;
    height: 0.625rem;
    align-items: center;
    justify-content: center;
    font-size: 0.625rem;
    line-height: 1;
  }

  .request-tab-overflow-menu {
    position: absolute;
    top: 2.25rem;
    right: 3.5rem;
    z-index: 65;
    display: grid;
    width: min(19rem, calc(100vw - 2rem));
    max-height: min(24rem, calc(100vh - 5rem));
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-alt);
    box-shadow: 0 18px 54px rgba(0, 0, 0, 0.34);
    padding: 0.25rem;
  }

  .request-tab-overflow-item {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.25rem;
    padding: 0.35rem 0.35rem 0.35rem 0.6rem;
    color: var(--muted);
  }

  .request-tab-overflow-item:hover,
  .request-tab-overflow-item.selected {
    background: var(--surface);
    color: var(--text);
  }

  .request-tab-overflow-select {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
  }

  .request-tab-overflow-method {
    width: 3rem;
    flex: 0 0 3rem;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .request-tab-overflow-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
  }
</style>
