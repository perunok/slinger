<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import Header from './components/Header.svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import ExportCollectionDialog from './components/ExportCollectionDialog.svelte'
  import CollectionRunnerDialog from './components/CollectionRunnerDialog.svelte'
  import RequestPane from './components/RequestPane.svelte'
  import RightUtilitySidebar from './components/RightUtilitySidebar.svelte'
  import SaveResponseDialog from './components/SaveResponseDialog.svelte'
  import SaveRequestDialog from './components/SaveRequestDialog.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import Toolbar from './components/Toolbar.svelte'
  import Toast from './components/Toast.svelte'
  import {
    groupFoldersByParent,
    groupRequestsByFolder,
  } from './lib/collectionTree'
  import {
    formatPayload,
    type PayloadContentType,
  } from './lib/payloadFormatters'
  import {
    requestAuthParts,
    requestAuthsAreEqual,
    requestAuthTemplateValues,
    type AuthQueryParam,
    type RequestAuthDocument,
  } from './lib/authDocument'
  import { exportPostmanCollection } from './lib/postmanExport'
  import { save as showSaveDialog } from '@tauri-apps/plugin-dialog'
  import {
    extractParams,
    normalizeScriptListener,
    parseDocument,
    payloadContentTypeFromHeaders,
    requestScriptState,
    requestHeaders,
    requestResponses,
    requestScripts,
    resolveTemplate,
    scriptEventsEqual,
    scriptTextForListener,
    updateScriptListener,
    unresolvedVariables,
    type ActiveTab,
    type HeaderDocument,
    type RequestDocument,
    type RequestScriptState,
    type ScriptListener,
  } from './lib/requestDocument'
  import {
    type ApiFolder,
    type ApiRequest,
    type Collection,
    type Environment,
    type EnvironmentVariable,
    type HttpResponseData,
    type Workspace,
    createRequest,
    createCollection,
    createEnvironment,
    createWorkspace,
    applyCloudWorkspace,
    deleteCollection,
    deleteEnvironmentVariable,
    deleteRequest,
    ensureDefaultEnvironment,
    executeHttpRequest,
    getCollections,
    getDefaultExportPath,
    getEnvironmentVariables,
    getEnvironments,
    getFolders,
    getRequests,
    getWorkspaces,
    importPostmanCollection,
    isTauriRuntime,
    openExternalUrl,
    prepareBrowserAuthCallback,
    renameCollection,
    renameRequest,
    updateRequest,
    upsertEnvironmentVariable,
    waitForBrowserAuthCallback,
    writeExportFile,
  } from './tauri'
  import {
    CloudApiError,
    clearCloudSession,
    clearCloudSyncClientId,
    createCloudRealtimeToken,
    createCloudWorkspace,
    createCloudWorkspaceHost,
    defaultCloudClientVersion,
    defaultCloudPlatform,
    getCloudMe,
    getCloudWorkspace,
    getCloudWorkspaces,
    resolveCloudWorkspace,
    inviteCloudWorkspaceMember,
    isCloudSessionExpired,
    listCloudWorkspaceHosts,
    listCloudWorkspaceMembers,
    logoutCloudSession,
    pollDeviceAuth,
    publishCloudWorkspace,
    pushCloudWorkspaceOperations,
    pullCloudWorkspaceOperations,
    readCloudConfig,
    readCloudSession,
    readCloudSyncClientId,
    readCloudWorkspaceCheckpoint,
    readCloudWorkspaceLink,
    refreshCloudSession as refreshRemoteCloudSession,
    registerCloudSyncClient,
    sessionFromTokenResponse,
    startDeviceAuth,
    submitCloudJoinRequest,
    type CloudConfig,
    type CloudDeviceFlowState,
    type CloudHostBinding,
    type CloudHostKind,
    type CloudInvite,
    type CloudJoinRequest,
    type CloudRealtimeTokenResponse,
    type CloudSession,
    type CloudSyncOperation,
    type CloudSyncPullResponse,
    type CloudSyncPushResponse,
    type CloudUser,
    type CloudWorkspace,
    type CloudWorkspaceMember,
    type CloudWorkspaceRole,
    updateCloudWorkspaceMemberRole,
    writeCloudConfig,
    writeCloudSession,
    writeCloudWorkspaceCheckpoint,
    writeCloudSyncClientId,
    writeCloudWorkspaceLink,
  } from './cloud'

  type Theme = 'dark' | 'light'
  type Orientation = 'vertical' | 'horizontal'
  type ConfirmationTone = 'default' | 'danger'
  type ConfirmationRequest = {
    message: string
    confirmLabel: string
    tone: ConfirmationTone
    resolve: (confirmed: boolean) => void
  }
  type SaveRequestTarget = {
    name: string
    collectionId: string
  }
  type SaveRequestDialogRequest = {
    requestName: string
    selectedCollectionId: string | null
    resolve: (target: SaveRequestTarget | null) => void
  }
  type SaveResponseDialogRequest = {
    existingNames: string[]
    resolve: (name: string | null) => void
  }
  type ExportCollectionTarget = {
    collectionName: string
    defaultValue: string
    mode: 'path' | 'file'
  }
  type ExportCollectionDialogRequest = ExportCollectionTarget & {
    resolve: (value: string | null) => void
  }
  type BrowserSaveFileWritable = {
    write: (contents: BlobPart) => void | Promise<void>
    close: () => void | Promise<void>
  }
  type BrowserSaveFileHandle = {
    name?: string
    createWritable: () => Promise<BrowserSaveFileWritable>
  }
  type BrowserSaveFilePicker = (options: {
    suggestedName?: string
    types?: Array<{
      description: string
      accept: Record<string, string[]>
    }>
  }) => Promise<BrowserSaveFileHandle>
  type RequestTabState = {
    request: ApiRequest
    savedRequest: ApiRequest | null
    sendResult: HttpResponseData | null
    sendError: string | null
    responseContentType: PayloadContentType
  }
  type RequestTabItem = {
    id: string
    name: string
    method: string
    hasChanges: boolean
  }
  type UtilityTab = 'copy-request' | 'environment' | 'cloud'
  type CopyFormat = 'curl'
  type BuiltRequest = {
    method: string
    url: string
    headers: Array<{ key: string; value: string }>
    body: string
    missingVariables: string[]
  }
  type BuildResolvedRequestInput = {
    method: string
    url: string
    body: string
    headers: HeaderDocument[]
    auth: unknown
    variables: EnvironmentVariable[]
    now?: Date
  }
  const REQUEST_CONTENT_TYPE_HEADER: Record<PayloadContentType, string> = {
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    text: 'text/plain',
    binary: 'application/octet-stream',
  }
  const DEFAULT_REQUEST_HEADERS: HeaderDocument[] = [
    { key: 'Content-Type', value: REQUEST_CONTENT_TYPE_HEADER.json },
    { key: 'Content-Length', value: '<auto>' },
    { key: 'Host', value: '<auto>' },
    { key: 'User-Agent', value: 'Slinger' },
    { key: 'Accept', value: '*/*' },
    { key: 'Accept-Encoding', value: 'gzip,deflate,br' },
    { key: 'Connection', value: 'keep-alive' },
  ]
  const AUTO_REQUEST_HEADER_KEYS = new Set(['host', 'content-length'])

  let workspaces: Workspace[] = []
  let collections: Collection[] = []
  let folders: ApiFolder[] = []
  let requests: ApiRequest[] = []
  let openRequestTabs: RequestTabState[] = []
  let environments: Environment[] = []
  let environmentVariables: EnvironmentVariable[] = []
  let selectedWorkspaceId: string | null = null
  let selectedCollectionId: string | null = null
  let selectedRequestId: string | null = null
  let selectedEnvironmentId: string | null = null
  let openFolderIds = new Set<string>()
  let activeTab: ActiveTab = 'Body'
  let methodDraft = 'GET'
  let urlDraft = ''
  let bodyDraft = ''
  let environmentName = ''
  let variableKey = ''
  let variableValue = ''
  let sendResult: HttpResponseData | null = null
  let sendError: string | null = null
  let sending = false
  let sendingRequestIds = new Set<string>()
  let requestAbortControllers = new Map<string, AbortController>()
  let savingResponse = false
  let savingRequest = false
  let workspaceName = ''
  let collectionName = ''
  let loadingWorkspaces = true
  let loadingCollections = false
  let sidebarWidth = 385
  let sidebarResizing = false
  let loadingRequests = false
  let confirmation: ConfirmationRequest | null = null
  let saveRequestDialog: SaveRequestDialogRequest | null = null
  let saveResponseDialog: SaveResponseDialogRequest | null = null
  let exportCollectionDialog: ExportCollectionDialogRequest | null = null
  let collectionRunner: { collection: Collection; requests: ApiRequest[] } | null = null
  let error: string | null = null
  let notice: string | null = null
  let orientation: Orientation = window.localStorage.getItem('slinger-orientation') === 'horizontal'
    ? 'horizontal'
    : 'vertical'
  let theme: Theme = window.localStorage.getItem('slinger-theme') === 'light' ? 'light' : 'dark'
  let selectedResponseIndex = 0
  let selectedResponseRequestId: string | null = null
  let responseViewTab: 'headers' | 'body' = 'body'
  let requestContentType: PayloadContentType = 'json'
  let responseContentType: PayloadContentType = 'json'
  let rightSidebarOpen = window.localStorage.getItem('slinger-right-sidebar-open') === 'true'
  let rightUtilityTab: UtilityTab = 'copy-request'
  let copyRequestFormat: CopyFormat = 'curl'
  let builtCopyRequest: BuiltRequest | null = null
  let copyRequestCurl = ''
  let copyRequestMissingVariables: string[] = []
  const initialCloudConfig = readCloudConfig()
  let cloudConfig: CloudConfig = initialCloudConfig
  let cloudApiBaseUrl = initialCloudConfig.apiBaseUrl
  let cloudDeviceName = initialCloudConfig.deviceName
  let cloudSession: CloudSession | null = readCloudSession()
  let cloudSignInAttempt = 0
  let cloudUser: CloudUser | null = null
  let cloudWorkspaces: CloudWorkspace[] = []
  let cloudBusy = false
  let cloudPublishBusy = false
  let cloudDeviceFlow: CloudDeviceFlowState | null = null
  let selectedCloudWorkspaceId: string | null = null
  let cloudWorkspaceMembers: CloudWorkspaceMember[] = []
  let cloudWorkspaceHosts: CloudHostBinding[] = []
  let cloudSyncClientId = readCloudSyncClientId(cloudApiBaseUrl)
  let cloudSyncCheckpoint = 0
  let cloudLastInvite: CloudInvite | null = null
  let cloudLastJoinRequest: CloudJoinRequest | null = null
  let cloudLastPush: CloudSyncPushResponse | null = null
  let cloudLastPull: CloudSyncPullResponse | null = null
  let cloudLastRealtimeToken: CloudRealtimeTokenResponse | null = null

  let collectionsLoadToken = 0
  let environmentsLoadToken = 0
  let variablesLoadToken = 0
  let collectionTreeLoadToken = 0
  let cloudWorkspaceDetailsLoadToken = 0
  let cloudWorkspaceSelectionToken = 0
  let lastWorkspaceId: string | null | undefined
  let lastEnvironmentId: string | null | undefined
  let lastCollectionId: string | null | undefined
  let lastRequestId: string | null | undefined
  let lastCloudWorkspaceId: string | null | undefined

  $: selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null
  $: selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null
  $: selectedRequestTab = openRequestTabs.find((tab) => tab.request.id === selectedRequestId) ?? null
  $: selectedCloudWorkspace = cloudWorkspaces.find((workspace) => workspace.id === selectedCloudWorkspaceId) ?? null
  $: isDraftRequest = Boolean(selectedRequestTab && !selectedRequestTab.savedRequest)
  $: selectedRequest = selectedRequestTab?.request ?? null
  $: selectedSavedRequest = selectedRequestTab?.savedRequest ?? null
  $: selectedRequestCollection =
    collections.find((collection) => collection.id === selectedRequest?.collection_id) ??
    selectedCollection
  $: selectedDocument = parseDocument(selectedRequest)
  $: headers = headersWithDefaultPresets(requestHeaders(selectedDocument))
  $: responseExamples = requestResponses(selectedDocument)
  $: selectedResponse =
    selectedResponseRequestId === selectedRequestId
      ? responseExamples[selectedResponseIndex] ?? null
      : null
  $: bodyFormat = formatPayload(bodyDraft, requestContentType)
  $: bodyIsValid = bodyFormat.ok && !/\{\{[^}]+\}\}/.test(bodyDraft)
  $: selectedSavedDocument = parseDocument(selectedSavedRequest)
  $: savedRequestBody = selectedSavedDocument.body?.raw ?? ''
  $: savedRequestHeaders = headersWithDefaultPresets(requestHeaders(selectedSavedDocument))
  $: savedRequestContentType = payloadContentTypeFromHeaders(savedRequestHeaders) ?? 'json'
  $: savedRequestMethod = selectedSavedDocument.method ?? selectedSavedRequest?.method ?? ''
  $: requestHasChanges = Boolean(
    selectedRequestTab &&
      (!selectedSavedRequest ||
        urlDraft !== selectedSavedRequest.url ||
        bodyDraft !== savedRequestBody ||
        requestContentType !== savedRequestContentType ||
        !headersAreEqual(headers, savedRequestHeaders) ||
        !scriptsAreEqual(selectedDocument, selectedSavedDocument) ||
        !requestAuthsAreEqual(selectedDocument.auth, selectedSavedDocument.auth) ||
        methodDraft !== savedRequestMethod),
  )
  $: openRequestTabItems = openRequestTabs.map(tabStateToItem)
  $: params = extractParams(urlDraft, selectedDocument)
  $: scripts = requestScriptState(selectedDocument)
  $: description =
    typeof selectedDocument.description === 'string' ? selectedDocument.description.trim() : ''
  $: sending = selectedRequestId ? sendingRequestIds.has(selectedRequestId) : false
  $: resolvedUrlPreview = resolveTemplate(urlDraft, environmentVariables)
  $: builtCopyRequest = selectedRequest
    ? buildResolvedRequest({
        method: methodDraft,
        url: urlDraft,
        body: bodyDraft,
        headers,
        auth: selectedDocument.auth,
        variables: environmentVariables,
      })
    : null
  $: copyRequestCurl = builtCopyRequest ? curlCommandFromBuiltRequest(builtCopyRequest) : ''
  $: copyRequestMissingVariables = builtCopyRequest?.missingVariables ?? []
  $: foldersByParent = groupFoldersByParent(folders)
  $: requestsByFolder = groupRequestsByFolder(requests)
  $: if (selectedResponseIndex >= responseExamples.length) {
    selectedResponseIndex = 0
    selectedResponseRequestId = null
  }
  $: if (selectedResponseRequestId && selectedResponseRequestId !== selectedRequestId) {
    selectedResponseRequestId = null
  }
  $: {
    window.localStorage.setItem('slinger-orientation', orientation)
  }
  $: {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('slinger-theme', theme)
  }
  $: {
    window.localStorage.setItem('slinger-right-sidebar-open', String(rightSidebarOpen))
  }
  $: {
    if (selectedWorkspaceId !== lastWorkspaceId) {
      lastWorkspaceId = selectedWorkspaceId

      if (!selectedWorkspaceId) {
        collectionsLoadToken += 1
        environmentsLoadToken += 1
        cancelAllRequests()
        collections = []
        environments = []
        environmentVariables = []
        selectedCollectionId = null
        selectedEnvironmentId = null
        openRequestTabs = []
        selectedRequestId = null
        selectedResponseRequestId = null
      } else {
        cancelAllRequests()
        openRequestTabs = []
        selectedRequestId = null
        selectedResponseRequestId = null
        void loadCollections(selectedWorkspaceId)
        void loadEnvironments(selectedWorkspaceId)
      }
    }
  }
  $: {
    if (selectedEnvironmentId !== lastEnvironmentId) {
      lastEnvironmentId = selectedEnvironmentId

      if (!selectedEnvironmentId) {
        variablesLoadToken += 1
        environmentVariables = []
      } else {
        void loadVariables(selectedEnvironmentId)
      }
    }
  }
  $: {
    if (selectedCollectionId !== lastCollectionId) {
      lastCollectionId = selectedCollectionId

      if (!selectedCollectionId) {
        collectionTreeLoadToken += 1
        folders = []
        requests = []
      } else {
        void loadCollectionTree(selectedCollectionId)
      }
    }
  }
  $: {
    cloudSyncClientId = readCloudSyncClientId(cloudApiBaseUrl)
  }
  $: {
    const linkedWorkspaceId = selectedWorkspace ? readCloudWorkspaceLink(cloudApiBaseUrl, selectedWorkspace.id) : null
    const nextSelectedCloudWorkspaceId =
      linkedWorkspaceId && cloudWorkspaces.some((workspace) => workspace.id === linkedWorkspaceId)
        ? linkedWorkspaceId
        : null

    if (nextSelectedCloudWorkspaceId !== selectedCloudWorkspaceId) {
      selectedCloudWorkspaceId = nextSelectedCloudWorkspaceId
    }
  }
  $: {
    if (selectedCloudWorkspaceId !== lastCloudWorkspaceId) {
      lastCloudWorkspaceId = selectedCloudWorkspaceId

      if (selectedCloudWorkspaceId) {
        cloudSyncCheckpoint = readCloudWorkspaceCheckpoint(cloudApiBaseUrl, selectedCloudWorkspaceId)
      }

      if (!selectedCloudWorkspaceId) {
        cloudWorkspaceDetailsLoadToken += 1
        resetCloudWorkspaceDetails()
      } else if (cloudUser) {
        void loadCloudWorkspaceDetails(selectedCloudWorkspaceId)
      }
    }
  }
  $: {
    const requestId = selectedRequest?.id ?? null

    if (requestId !== lastRequestId) {
      lastRequestId = requestId
      const currentDocument = parseDocument(selectedRequest)
      const rawBody = currentDocument.body?.raw ?? ''
      methodDraft = selectedRequest?.method ?? 'GET'
      urlDraft = selectedRequest?.url ?? ''
      bodyDraft = rawBody
      requestContentType = payloadContentTypeFromHeaders(requestHeaders(currentDocument)) ?? 'json'
      sendResult = selectedRequestTab?.sendResult ?? null
      sendError = selectedRequestTab?.sendError ?? null
      responseContentType = selectedRequestTab?.responseContentType ?? 'json'
      activeTab = isDraftRequest || rawBody ? 'Body' : 'Docs'
    }
  }

  onMount(() => {
    void loadWorkspaces()
    if (cloudSession) {
      void refreshCloudState(true)
    }
    window.addEventListener('keydown', handleGlobalKeydown, true)
  })

  onDestroy(() => {
    stopResize()
    cancelAllRequests()
    window.removeEventListener('keydown', handleGlobalKeydown, true)
  })

  function startResize(event: PointerEvent) {
    sidebarResizing = true
    event.preventDefault()
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stopResize)
  }

  function resize(event: PointerEvent) {
    if (!sidebarResizing) return

    const nextWidth = event.clientX
    sidebarWidth = Math.min(Math.max(nextWidth, 280), 720)
  }

  function stopResize() {
    if (!sidebarResizing) return
    sidebarResizing = false
    window.removeEventListener('pointermove', resize)
    window.removeEventListener('pointerup', stopResize)
  }

  function askForConfirmation(options: {
    message: string
    confirmLabel?: string
    tone?: ConfirmationTone
  }): Promise<boolean> {
    confirmation?.resolve(false)

    return new Promise((resolve) => {
      confirmation = {
        message: options.message,
        confirmLabel: options.confirmLabel ?? 'Confirm',
        tone: options.tone ?? 'default',
        resolve,
      }
    })
  }

  function finishConfirmation(confirmed: boolean) {
    if (!confirmation) return

    const current = confirmation
    confirmation = null
    current.resolve(confirmed)
  }

  function askForRequestSaveTarget(options: {
    requestName: string
    selectedCollectionId: string | null
  }): Promise<SaveRequestTarget | null> {
    saveRequestDialog?.resolve(null)

    return new Promise((resolve) => {
      saveRequestDialog = {
        requestName: options.requestName,
        selectedCollectionId: options.selectedCollectionId,
        resolve,
      }
    })
  }

  function finishRequestSaveDialog(target: SaveRequestTarget | null) {
    if (!saveRequestDialog) return

    const current = saveRequestDialog
    saveRequestDialog = null
    current.resolve(target)
  }

  function askForResponseName(existingNames: string[]): Promise<string | null> {
    saveResponseDialog?.resolve(null)

    return new Promise((resolve) => {
      saveResponseDialog = {
        existingNames,
        resolve,
      }
    })
  }

  function finishResponseSaveDialog(name: string | null) {
    if (!saveResponseDialog) return

    const current = saveResponseDialog
    saveResponseDialog = null
    current.resolve(name)
  }

  function askForExportDestination(options: ExportCollectionTarget): Promise<string | null> {
    exportCollectionDialog?.resolve(null)

    return new Promise((resolve) => {
      exportCollectionDialog = {
        ...options,
        resolve,
      }
    })
  }

  function finishExportCollectionDialog(value: string | null) {
    if (!exportCollectionDialog) return

    const current = exportCollectionDialog
    exportCollectionDialog = null
    current.resolve(value)
  }

  function comparableHeaders(headers: HeaderDocument[]) {
    return headers.map((header) => ({
      key: header.key ?? '',
      value: header.value ?? '',
      disabled: Boolean(header.disabled),
    }))
  }

  function headersAreEqual(left: HeaderDocument[], right: HeaderDocument[]): boolean {
    return JSON.stringify(comparableHeaders(left)) === JSON.stringify(comparableHeaders(right))
  }

  function normalizedHeaderKey(header: { key?: string }): string {
    return header.key?.trim().toLowerCase() ?? ''
  }

  function headersWithDefaultPresets(headers: HeaderDocument[]): HeaderDocument[] {
    const existingKeys = new Set(headers.map(normalizedHeaderKey).filter(Boolean))
    const missingHeaders = DEFAULT_REQUEST_HEADERS
      .filter((header) => !existingKeys.has(normalizedHeaderKey(header)))
      .map((header) => ({ ...header }))

    return [...headers, ...missingHeaders]
  }

  function scriptsAreEqual(left: RequestDocument, right: RequestDocument): boolean {
    return scriptEventsEqual(requestScripts(left), requestScripts(right))
  }

  function createRequestTabState(
    request: ApiRequest,
    savedRequest: ApiRequest | null,
  ): RequestTabState {
    return {
      request,
      savedRequest,
      sendResult: null,
      sendError: null,
      responseContentType: 'json',
    }
  }

  function requestTabHasChanges(tab: RequestTabState): boolean {
    const savedRequest = tab.savedRequest
    if (!savedRequest) return true

    const draftDocument = parseDocument(tab.request)
    const savedDocument = parseDocument(savedRequest)
    const draftBody = draftDocument.body?.raw ?? ''
    const savedBody = savedDocument.body?.raw ?? ''
    const draftHeaders = headersWithDefaultPresets(requestHeaders(draftDocument))
    const savedHeaders = headersWithDefaultPresets(requestHeaders(savedDocument))
    const draftContentType = payloadContentTypeFromHeaders(draftHeaders) ?? 'json'
    const savedContentType = payloadContentTypeFromHeaders(savedHeaders) ?? 'json'
    const draftMethod = draftDocument.method ?? tab.request.method
    const savedMethod = savedDocument.method ?? savedRequest.method

    return (
      tab.request.url !== savedRequest.url ||
      draftBody !== savedBody ||
      draftContentType !== savedContentType ||
      !headersAreEqual(draftHeaders, savedHeaders) ||
      !scriptsAreEqual(draftDocument, savedDocument) ||
      !requestAuthsAreEqual(draftDocument.auth, savedDocument.auth) ||
      draftMethod !== savedMethod
    )
  }

  function tabStateToItem(tab: RequestTabState): RequestTabItem {
    return {
      id: tab.request.id,
      name: tab.request.name,
      method: tab.request.method,
      hasChanges: requestTabHasChanges(tab),
    }
  }

  function selectOpenRequestTab(requestId: string | null) {
    if (!requestId) {
      selectedRequestId = null
      return
    }

    if (openRequestTabs.some((tab) => tab.request.id === requestId)) {
      selectedRequestId = requestId
      return
    }

    const request = requests.find((item) => item.id === requestId)
    if (!request) return

    openRequestTabs = [
      ...openRequestTabs,
      createRequestTabState(request, request),
    ]
    selectedRequestId = request.id
  }

  function selectRequest(requestId: string | null) {
    selectedResponseRequestId = null
    selectOpenRequestTab(requestId)
  }

  function selectResponseExample(requestId: string, responseIndex: number) {
    const request =
      openRequestTabs.find((tab) => tab.request.id === requestId)?.request ??
      requests.find((item) => item.id === requestId)
    const response = requestResponses(parseDocument(request ?? null))[responseIndex]

    if (!request || !response) return

    selectOpenRequestTab(requestId)
    selectedResponseRequestId = requestId
    selectedResponseIndex = responseIndex
    sendResult = null
    sendError = null
    updateRequestTabResponse(requestId, {
      sendResult: null,
      sendError: null,
    })
    responseViewTab = 'body'

    const responseHeaders = Array.isArray(response.header) ? response.header : []
    const detectedContentType = payloadContentTypeFromHeaders(responseHeaders)
    const nextResponseContentType = detectedContentType ?? responseContentType
    responseContentType = nextResponseContentType
    updateRequestTabResponse(requestId, {
      responseContentType: nextResponseContentType,
    })
  }

  function updateSelectedRequestTab(request: ApiRequest, savedRequest?: ApiRequest | null) {
    openRequestTabs = openRequestTabs.map((tab) =>
      tab.request.id === request.id
        ? {
            ...tab,
            request,
            savedRequest: savedRequest === undefined ? tab.savedRequest : savedRequest,
          }
        : tab,
    )
  }

  function updateRequestTabResponse(
    requestId: string,
    values: {
      sendResult?: HttpResponseData | null
      sendError?: string | null
      responseContentType?: PayloadContentType
    },
  ) {
    openRequestTabs = openRequestTabs.map((tab) =>
      tab.request.id === requestId
        ? {
            ...tab,
            ...values,
          }
        : tab,
    )
  }

  function setRequestSending(requestId: string, value: boolean) {
    const next = new Set(sendingRequestIds)
    if (value) next.add(requestId)
    else next.delete(requestId)
    sendingRequestIds = next
  }

  function cancelRequest(requestId: string) {
    const controller = requestAbortControllers.get(requestId)
    if (!controller) return

    controller.abort()
    requestAbortControllers.delete(requestId)
    setRequestSending(requestId, false)
  }

  function cancelRequests(requestIds: string[]) {
    for (const requestId of requestIds) {
      cancelRequest(requestId)
    }
  }

  function cancelAllRequests() {
    cancelRequests([...requestAbortControllers.keys()])
  }

  function editableRequestDocument(
    request: ApiRequest,
    values: {
      method: string
      url: string
      body: string
      contentType: PayloadContentType
      headers?: HeaderDocument[]
      auth?: RequestAuthDocument | null
      scripts?: Partial<RequestScriptState>
      name?: string
    },
  ): RequestDocument {
    const document = parseDocument(request)
    const hasAuth = Object.prototype.hasOwnProperty.call(values, 'auth')
    const hasScripts = Object.prototype.hasOwnProperty.call(values, 'scripts')
    const nextScriptState = hasScripts
      ? {
          ...requestScriptState(document),
          ...(values.scripts ?? {}),
        }
      : null
    const nextScripts = nextScriptState
      ? (
          [
            ['prerequest', nextScriptState.prerequest],
            ['test', nextScriptState.test],
          ] as const
        ).reduce(
          (events, [listener, value]) =>
            updateScriptListener(events, listener, value),
          requestScripts(document).filter(
            (event) => !['prerequest', 'test'].includes(normalizeScriptListener(event.listen)),
          ),
        )
      : document.scripts

    return {
      ...document,
      name: values.name ?? document.name ?? request.name,
      method: values.method,
      url: values.url,
      headers: values.headers ?? headersWithContentType(headersWithDefaultPresets(requestHeaders(document)), values.contentType),
      auth: hasAuth ? values.auth : document.auth,
      scripts: nextScripts,
      body: {
        ...(document.body ?? {}),
        mode: document.body?.mode ?? 'raw',
        raw: values.body,
      },
    }
  }

  function updateSelectedRequestDraft(values: {
    method?: string
    url?: string
    body?: string
    contentType?: PayloadContentType
    headers?: HeaderDocument[]
    auth?: RequestAuthDocument | null
    scripts?: Partial<RequestScriptState>
    name?: string
  }) {
    if (!selectedRequest) return

    const nextMethod = values.method ?? methodDraft
    const nextUrl = values.url ?? urlDraft
    const nextBody = values.body ?? bodyDraft
    const nextContentType = values.contentType ?? requestContentType
    const nextName = values.name ?? selectedRequest.name
    const nextValues: {
      method: string
      url: string
      body: string
      contentType: PayloadContentType
      headers?: HeaderDocument[]
      auth?: RequestAuthDocument | null
      scripts?: Partial<RequestScriptState>
      name: string
    } = {
      method: nextMethod,
      url: nextUrl,
      body: nextBody,
      contentType: nextContentType,
      headers: values.headers,
      name: nextName,
    }

    if (Object.prototype.hasOwnProperty.call(values, 'auth')) {
      nextValues.auth = values.auth
    }
    if (Object.prototype.hasOwnProperty.call(values, 'scripts')) {
      nextValues.scripts = values.scripts
    }

    const nextDocument = editableRequestDocument(selectedRequest, nextValues)
    const nextRequest = {
      ...selectedRequest,
      name: nextName,
      method: nextMethod,
      url: nextUrl,
      document_json: JSON.stringify(nextDocument),
    }

    updateSelectedRequestTab(nextRequest)
  }

  function requestWithName(request: ApiRequest, name: string): ApiRequest {
    const document = parseDocument(request)

    return {
      ...request,
      name,
      document_json: JSON.stringify({
        ...document,
        name,
      }),
    }
  }

  function slugifyCloudWorkspaceName(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
  }

  function cloudIsoFromUnixSeconds(value: number): string {
    return new Date(value * 1000).toISOString()
  }

  function createCloudOperationId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function resetCloudWorkspaceDetails() {
    cloudWorkspaceMembers = []
    cloudWorkspaceHosts = []
    cloudLastInvite = null
    cloudLastJoinRequest = null
    cloudLastPull = null
    cloudLastPush = null
    cloudLastRealtimeToken = null
    cloudSyncCheckpoint = 0
  }

  function resetCloudState(options: { clearSession?: boolean; clearSyncClient?: boolean } = {}) {
    cloudUser = null
    cloudWorkspaces = []
    selectedCloudWorkspaceId = null
    cloudDeviceFlow = null
    resetCloudWorkspaceDetails()

    if (options.clearSession) {
      cloudSession = null
      clearCloudSession()
    }

    if (options.clearSyncClient) {
      cloudSyncClientId = null
      clearCloudSyncClientId(cloudApiBaseUrl)
    }
  }

  async function ensureCloudSession(): Promise<CloudSession> {
    const existing = cloudSession ?? readCloudSession()
    if (!existing) throw new Error('Sign in to Slinger Cloud first.')

    if (!isCloudSessionExpired(existing)) {
      cloudSession = existing
      return existing
    }

    try {
      const refreshed = await refreshRemoteCloudSession(cloudApiBaseUrl, existing.refreshToken)
      const nextSession = sessionFromTokenResponse(refreshed)
      cloudSession = nextSession
      writeCloudSession(nextSession)
      return nextSession
    } catch (err) {
      resetCloudState({ clearSession: true, clearSyncClient: true })
      throw err
    }
  }

  async function loadCloudWorkspaceDetails(workspaceId: string) {
    const token = ++cloudWorkspaceDetailsLoadToken

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId,
        slug: cloudWorkspaces.find((workspace) => workspace.id === workspaceId)?.slug,
      })
      const resolvedWorkspaceId = resolved.workspace.id
      const detail = await getCloudWorkspace(cloudApiBaseUrl, session.accessToken, resolvedWorkspaceId)
      if (token !== cloudWorkspaceDetailsLoadToken) return

      selectedCloudWorkspaceId = resolvedWorkspaceId
      cloudWorkspaces = [
        resolved.workspace,
        ...cloudWorkspaces.filter((workspace) => workspace.id !== resolvedWorkspaceId),
      ]
      cloudWorkspaces = cloudWorkspaces.map((workspace) =>
        workspace.id === resolvedWorkspaceId
          ? {
              ...workspace,
              ...resolved.workspace,
              ...detail.workspace,
              role: detail.role ?? detail.effective_role ?? workspace.role,
            }
          : workspace,
      )
    } catch (err) {
      console.error(err)
      if (token === cloudWorkspaceDetailsLoadToken) {
        error = err instanceof Error ? err.message : 'Unable to load remote workspace details.'
      }
    }
  }

  async function refreshCloudState(silent = false) {
    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const [me, workspaceResponse] = await Promise.all([
        getCloudMe(cloudApiBaseUrl, session.accessToken),
        getCloudWorkspaces(cloudApiBaseUrl, session.accessToken),
      ])

      cloudUser = me.user
      cloudWorkspaces = workspaceResponse.items
      const linkedWorkspaceId = selectedWorkspace ? readCloudWorkspaceLink(cloudApiBaseUrl, selectedWorkspace.id) : null
      selectedCloudWorkspaceId =
        linkedWorkspaceId && workspaceResponse.items.some((workspace) => workspace.id === linkedWorkspaceId)
          ? linkedWorkspaceId
          : null
      cloudSyncClientId = readCloudSyncClientId(cloudApiBaseUrl)

      if (selectedCloudWorkspaceId) {
        await loadCloudWorkspaceDetails(selectedCloudWorkspaceId)
      } else {
        resetCloudWorkspaceDetails()
      }

      if (!silent) notice = `Loaded ${workspaceResponse.items.length} cloud workspace${workspaceResponse.items.length === 1 ? '' : 's'}.`
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to refresh cloud state.'
    } finally {
      cloudBusy = false
    }
  }

  function saveCloudConfig() {
    writeCloudConfig({
      apiBaseUrl: cloudApiBaseUrl,
      deviceName: cloudDeviceName,
    })
    cloudConfig = readCloudConfig()
    cloudApiBaseUrl = cloudConfig.apiBaseUrl
    cloudDeviceName = cloudConfig.deviceName
    cloudSyncClientId = readCloudSyncClientId(cloudApiBaseUrl)
    resetCloudWorkspaceDetails()
    notice = 'Cloud configuration saved.'
    error = null
  }

  async function startCloudSignIn() {
    cloudBusy = true

    try {
      const response = await startDeviceAuth(cloudApiBaseUrl, cloudDeviceName)
      const signInAttempt = ++cloudSignInAttempt
      let verificationUrl = response.verification_uri_complete
      let localCallback: { callbackId: string; callbackUrl: string } | null = null

      if (isTauriRuntime) {
        localCallback = await prepareBrowserAuthCallback()
        const callbackAwareUrl = new URL(verificationUrl)
        callbackAwareUrl.searchParams.set('callback_url', localCallback.callbackUrl)
        verificationUrl = callbackAwareUrl.toString()
      }

      cloudDeviceFlow = {
        ...response,
        verification_uri_complete: verificationUrl,
        startedAt: Date.now(),
      }

      if (localCallback) {
        void waitForBrowserAuthCallback(localCallback.callbackId, response.expires_in * 1000)
          .then(async () => {
            if (!cloudDeviceFlow || cloudDeviceFlow.device_code !== response.device_code || signInAttempt !== cloudSignInAttempt) {
              return
            }

            await pollCloudSignIn()
          })
          .catch((err) => {
            console.error(err)
          })
      }

      await openExternalUrl(verificationUrl)

      notice = localCallback
        ? 'Device sign-in started. Your browser was opened and will confirm automatically after login.'
        : 'Device sign-in started. Your browser was opened for login and password change if required.'
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to start cloud sign-in.'
    } finally {
      cloudBusy = false
    }
  }

  async function pollCloudSignIn() {
    if (!cloudDeviceFlow) return

    cloudBusy = true

    try {
      const response = await pollDeviceAuth(cloudApiBaseUrl, cloudDeviceFlow.device_code)
      if (response.status === 'pending') {
        notice = 'Cloud sign-in is still pending.'
        return
      }

      const session = sessionFromTokenResponse(response)
      cloudSession = session
      writeCloudSession(session)
      cloudUser = response.user
      cloudDeviceFlow = null
      await refreshCloudState(true)
      if (selectedCloudWorkspaceId) {
        const remoteWorkspace = cloudWorkspaces.find((workspace) => workspace.id === selectedCloudWorkspaceId)
        if (remoteWorkspace) {
          await hydrateLocalWorkspaceFromRemote(remoteWorkspace)
          notice = `Signed in as ${response.user.display_name} and synced "${remoteWorkspace.name}".`
        } else {
          notice = `Signed in as ${response.user.display_name}.`
        }
      } else {
        notice = `Signed in as ${response.user.display_name}.`
      }
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to complete cloud sign-in.'
    } finally {
      cloudBusy = false
    }
  }

  async function signOutCloud() {
    cloudBusy = true

    try {
      const session = cloudSession ?? readCloudSession()
      if (session) {
        await logoutCloudSession(cloudApiBaseUrl, session.refreshToken).catch(() => undefined)
      }
    } finally {
      resetCloudState({ clearSession: true, clearSyncClient: true })
      cloudBusy = false
      notice = 'Signed out from Slinger Cloud.'
      error = null
    }
  }

  async function ensureCloudSyncClientRegistered(): Promise<string> {
    if (cloudSyncClientId) return cloudSyncClientId

    const session = await ensureCloudSession()
    const response = await registerCloudSyncClient(cloudApiBaseUrl, session.accessToken, {
      clientVersion: defaultCloudClientVersion(),
      deviceName: cloudDeviceName,
      platform: defaultCloudPlatform(),
    })

    cloudSyncClientId = response.client.client_id
    writeCloudSyncClientId(cloudApiBaseUrl, response.client.client_id)
    return response.client.client_id
  }

  function findLinkedLocalWorkspaceId(remoteWorkspaceId: string): string | null {
    for (const workspace of workspaces) {
      if (readCloudWorkspaceLink(cloudApiBaseUrl, workspace.id) === remoteWorkspaceId) {
        return workspace.id
      }
    }
    return null
  }

  async function syncSelectedLocalWorkspaceForCloudWorkspace(
    workspaceId: string,
    selectionToken: number,
  ) {
    const linkedLocalWorkspaceId = findLinkedLocalWorkspaceId(workspaceId)
    if (
      linkedLocalWorkspaceId &&
      workspaces.some((workspace) => workspace.id === linkedLocalWorkspaceId)
    ) {
      if (selectionToken === cloudWorkspaceSelectionToken) {
        selectedWorkspaceId = linkedLocalWorkspaceId
      }
      return
    }

    const remoteWorkspace = cloudWorkspaces.find((workspace) => workspace.id === workspaceId)
    if (!remoteWorkspace || !cloudUser) return

    try {
      await hydrateLocalWorkspaceFromRemote(remoteWorkspace)
    } catch (err) {
      console.error(err)
      if (selectionToken === cloudWorkspaceSelectionToken) {
        error = err instanceof Error ? err.message : 'Unable to switch to that cloud workspace.'
      }
    }
  }

  function setSelectedCloudWorkspaceSelection(workspaceId: string | null) {
    selectedCloudWorkspaceId = workspaceId
    cloudWorkspaceSelectionToken += 1
    const selectionToken = cloudWorkspaceSelectionToken

    if (!workspaceId) return

    void syncSelectedLocalWorkspaceForCloudWorkspace(workspaceId, selectionToken)
  }

  async function ensureLocalWorkspaceForRemote(remoteWorkspace: CloudWorkspace): Promise<string> {
    const linkedWorkspaceId = findLinkedLocalWorkspaceId(remoteWorkspace.id)
    if (linkedWorkspaceId && workspaces.some((workspace) => workspace.id === linkedWorkspaceId)) {
      selectedWorkspaceId = linkedWorkspaceId
      return linkedWorkspaceId
    }

    const matchedByName = workspaces.find(
      (workspace) => workspace.name.trim().toLowerCase() === remoteWorkspace.name.trim().toLowerCase(),
    )
    if (matchedByName) {
      writeCloudWorkspaceLink(cloudApiBaseUrl, matchedByName.id, remoteWorkspace.id)
      selectedWorkspaceId = matchedByName.id
      return matchedByName.id
    }

    const created = await createWorkspace(remoteWorkspace.name)
    await loadWorkspaces()
    writeCloudWorkspaceLink(cloudApiBaseUrl, created.id, remoteWorkspace.id)
    selectedWorkspaceId = created.id
    return created.id
  }

  async function hydrateLocalWorkspaceFromRemote(remoteWorkspace: CloudWorkspace, forceFullPull = false) {
    const localWorkspaceId = await ensureLocalWorkspaceForRemote(remoteWorkspace)
    const session = await ensureCloudSession()
    const clientId = await ensureCloudSyncClientRegistered()
    const checkpoint = forceFullPull ? 0 : readCloudWorkspaceCheckpoint(cloudApiBaseUrl, remoteWorkspace.id)
    const response = await pullCloudWorkspaceOperations(
      cloudApiBaseUrl,
      session.accessToken,
      remoteWorkspace.id,
      {
        clientId,
        afterCheckpoint: checkpoint,
      },
    )

    if (response.operations.length > 0) {
      await applyCloudWorkspace(localWorkspaceId, response.operations)
      await loadWorkspaces()
    }

    await loadCollections(localWorkspaceId)
    await loadEnvironments(localWorkspaceId)

    selectedWorkspaceId = localWorkspaceId
    selectedCloudWorkspaceId = remoteWorkspace.id
    cloudLastPull = response
    cloudSyncCheckpoint = response.checkpoint
    writeCloudWorkspaceCheckpoint(cloudApiBaseUrl, remoteWorkspace.id, response.checkpoint)
    return response
  }

  async function buildWorkspaceSyncOperations(workspaceId: string): Promise<CloudSyncOperation[]> {
    const workspace = workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a local workspace first.')

    const workspaceCollections = await getCollections(workspaceId)
    const workspaceEnvironments = await getEnvironments(workspaceId)
    const collectionTrees = await Promise.all(
      workspaceCollections.map(async (collection) => ({
        collection,
        folders: await getFolders(collection.id),
        requests: await getRequests(collection.id),
      })),
    )
    const environmentPayloads = await Promise.all(
      workspaceEnvironments.map(async (environment) => ({
        environment,
        variables: await getEnvironmentVariables(environment.id),
      })),
    )

    const operations: CloudSyncOperation[] = [
      {
        operation_id: createCloudOperationId(),
        workspace_id: workspace.id,
        resource_type: 'workspace',
        resource_id: workspace.id,
        op: 'upsert',
        base_version: Math.max(workspace.version - 1, 0),
        payload: {
          name: workspace.name,
        },
        occurred_at: cloudIsoFromUnixSeconds(workspace.updated_at),
      },
    ]

    for (const collection of workspaceCollections) {
        operations.push({
        operation_id: createCloudOperationId(),
        workspace_id: workspace.id,
        resource_type: 'collection',
        resource_id: collection.id,
        op: 'upsert',
        base_version: Math.max(collection.version - 1, 0),
        payload: {
          name: collection.name,
        },
        occurred_at: cloudIsoFromUnixSeconds(collection.updated_at),
      })
    }

    for (const tree of collectionTrees) {
      for (const folder of tree.folders) {
        operations.push({
          operation_id: createCloudOperationId(),
          workspace_id: workspace.id,
          resource_type: 'folder',
          resource_id: folder.id,
          op: 'upsert',
          base_version: Math.max(folder.version - 1, 0),
          payload: {
            collection_id: tree.collection.id,
            parent_folder_id: folder.parent_folder_id,
            name: folder.name,
          },
          occurred_at: cloudIsoFromUnixSeconds(folder.updated_at),
        })
      }

      for (const request of tree.requests) {
        operations.push({
          operation_id: createCloudOperationId(),
          workspace_id: workspace.id,
          resource_type: 'request',
          resource_id: request.id,
          op: 'upsert',
          base_version: Math.max(request.version - 1, 0),
          payload: {
            collection_id: tree.collection.id,
            folder_id: request.folder_id,
            name: request.name,
            method: request.method,
            url: request.url,
            document_json: request.document_json,
          },
          occurred_at: cloudIsoFromUnixSeconds(request.updated_at),
        })
      }
    }

    for (const entry of environmentPayloads) {
      operations.push({
        operation_id: createCloudOperationId(),
        workspace_id: workspace.id,
        resource_type: 'environment',
        resource_id: entry.environment.id,
        op: 'upsert',
        base_version: Math.max(entry.environment.version - 1, 0),
        payload: {
          name: entry.environment.name,
        },
        occurred_at: cloudIsoFromUnixSeconds(entry.environment.updated_at),
      })

      for (const variable of entry.variables) {
        operations.push({
          operation_id: createCloudOperationId(),
          workspace_id: workspace.id,
          resource_type: 'environment_variable',
          resource_id: variable.id,
          op: 'upsert',
          base_version: Math.max(variable.version - 1, 0),
          payload: {
            environment_id: entry.environment.id,
            key: variable.key,
            value: variable.value,
            is_secret: variable.is_secret,
          },
          occurred_at: cloudIsoFromUnixSeconds(variable.updated_at),
        })
      }
    }

    return operations
  }

  async function pushWorkspaceSync() {
    if (!selectedWorkspace || !selectedCloudWorkspaceId) {
      error = 'Select both a local workspace and a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId: selectedCloudWorkspaceId,
        slug: selectedCloudWorkspace?.slug,
      })
      const clientId = await ensureCloudSyncClientRegistered()
      const operations = await buildWorkspaceSyncOperations(selectedWorkspace.id)
      const response = await pushCloudWorkspaceOperations(
        cloudApiBaseUrl,
        session.accessToken,
        resolved.workspace.id,
        {
          clientId,
          baseCheckpoint: cloudSyncCheckpoint,
          operations,
        },
      )

      cloudLastPush = response
      cloudSyncCheckpoint = response.checkpoint
      selectedCloudWorkspaceId = resolved.workspace.id
      writeCloudWorkspaceLink(cloudApiBaseUrl, selectedWorkspace.id, resolved.workspace.id)
      writeCloudWorkspaceCheckpoint(cloudApiBaseUrl, resolved.workspace.id, response.checkpoint)
      notice = `Pushed ${response.accepted.length} operation${response.accepted.length === 1 ? '' : 's'} to the cloud.`
      error = null
    } catch (err) {
      console.error(err)
      error = cloudPushErrorMessage(err, selectedCloudWorkspace)
    } finally {
      cloudBusy = false
    }
  }

  async function pullWorkspaceSync() {
    if (!selectedCloudWorkspaceId || !selectedCloudWorkspace) {
      error = 'Select a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const response = await hydrateLocalWorkspaceFromRemote(selectedCloudWorkspace)
      notice = `Pulled ${response.operations.length} operation${response.operations.length === 1 ? '' : 's'} from the cloud.`
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to pull cloud changes.'
    } finally {
      cloudBusy = false
    }
  }

  async function requestRealtimeToken() {
    if (!selectedCloudWorkspaceId) {
      error = 'Select a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId: selectedCloudWorkspaceId,
        slug: selectedCloudWorkspace?.slug,
      })
      const response = await createCloudRealtimeToken(
        cloudApiBaseUrl,
        session.accessToken,
        resolved.workspace.id,
        [
          `workspace:${resolved.workspace.id}:presence`,
          `workspace:${resolved.workspace.id}:events`,
        ],
      )

      cloudLastRealtimeToken = response
      selectedCloudWorkspaceId = resolved.workspace.id
      notice = 'Realtime token requested successfully.'
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to request a realtime token.'
    } finally {
      cloudBusy = false
    }
  }

  async function createRemoteWorkspace(input: { name: string; slug: string; description: string }) {
    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const response = await createCloudWorkspace(cloudApiBaseUrl, session.accessToken, input)
      cloudWorkspaces = [response.workspace, ...cloudWorkspaces.filter((workspace) => workspace.id !== response.workspace.id)]
      selectedCloudWorkspaceId = response.workspace.id
      notice = `Created remote workspace "${response.workspace.name}".`
      error = null
      await loadCloudWorkspaceDetails(response.workspace.id)
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to create a cloud workspace.'
    } finally {
      cloudBusy = false
    }
  }

  async function inviteCloudMember(input: { email: string; role: CloudWorkspaceRole }) {
    if (!selectedCloudWorkspaceId) {
      error = 'Select a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId: selectedCloudWorkspaceId,
        slug: selectedCloudWorkspace?.slug,
      })
      const response = await inviteCloudWorkspaceMember(
        cloudApiBaseUrl,
        session.accessToken,
        resolved.workspace.id,
        input,
      )

      cloudLastInvite = response.invite
      selectedCloudWorkspaceId = resolved.workspace.id
      notice = `Invite queued for ${response.invite.email}.`
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to invite that member.'
    } finally {
      cloudBusy = false
    }
  }

  async function createCloudJoinRequestAction(input: {
    message: string
    requestedRole: CloudWorkspaceRole
  }) {
    if (!selectedCloudWorkspaceId) {
      error = 'Select a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId: selectedCloudWorkspaceId,
        slug: selectedCloudWorkspace?.slug,
      })
      const response = await submitCloudJoinRequest(
        cloudApiBaseUrl,
        session.accessToken,
        resolved.workspace.id,
        input,
      )

      cloudLastJoinRequest = response.join_request
      selectedCloudWorkspaceId = resolved.workspace.id
      notice = 'Join request submitted.'
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to submit the join request.'
    } finally {
      cloudBusy = false
    }
  }

  async function addCloudHostAction(input: { host: string; kind: CloudHostKind }) {
    if (!selectedCloudWorkspaceId) {
      error = 'Select a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId: selectedCloudWorkspaceId,
        slug: selectedCloudWorkspace?.slug,
      })
      const response = await createCloudWorkspaceHost(
        cloudApiBaseUrl,
        session.accessToken,
        resolved.workspace.id,
        input,
      )

      cloudWorkspaceHosts = [...cloudWorkspaceHosts.filter((host) => host.id !== response.host.id), response.host]
      selectedCloudWorkspaceId = resolved.workspace.id
      notice = response.verification
        ? `Host added. Create ${response.verification.dns_record_type} ${response.verification.dns_record_name}.`
        : 'Host added to the remote workspace.'
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to add the workspace host.'
    } finally {
      cloudBusy = false
    }
  }

  async function changeCloudMemberRole(input: {
    memberId: string
    role: CloudWorkspaceRole
    version: number
  }) {
    if (!selectedCloudWorkspaceId) {
      error = 'Select a remote cloud workspace first.'
      return
    }

    cloudBusy = true

    try {
      const session = await ensureCloudSession()
      const resolved = await resolveCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceId: selectedCloudWorkspaceId,
        slug: selectedCloudWorkspace?.slug,
      })
      const response = await updateCloudWorkspaceMemberRole(
        cloudApiBaseUrl,
        session.accessToken,
        resolved.workspace.id,
        input.memberId,
        {
          role: input.role,
          version: input.version,
        },
      )

      cloudWorkspaceMembers = cloudWorkspaceMembers.map((member) =>
        member.id === input.memberId
          ? {
              ...member,
              role: response.member.role,
              version: response.member.version,
              updated_at: response.member.updated_at,
            }
          : member,
      )
      selectedCloudWorkspaceId = resolved.workspace.id
      notice = 'Workspace member role updated.'
      error = null
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to update the member role.'
    } finally {
      cloudBusy = false
    }
  }

  async function publishWorkspaceToCloud() {
    if (!selectedWorkspace) {
      error = 'Select a local workspace first.'
      return
    }
    if (!selectedCloudWorkspaceId || !selectedCloudWorkspace) {
      error = 'Select an existing remote cloud workspace first.'
      return
    }

    cloudPublishBusy = true

    try {
      const session = await ensureCloudSession()
      const clientId = await ensureCloudSyncClientRegistered()
      const response = await publishCloudWorkspace(cloudApiBaseUrl, session.accessToken, {
        workspaceName: selectedWorkspace.name,
        proposedSlug: selectedCloudWorkspace.slug,
        remoteWorkspaceId: selectedCloudWorkspace.id,
        publishMode: 'attach_existing',
        clientId,
        deviceName: cloudDeviceName,
      })

      cloudSyncClientId = response.sync_bootstrap.client_id
      writeCloudSyncClientId(cloudApiBaseUrl, response.sync_bootstrap.client_id)
      cloudSyncCheckpoint = response.sync_bootstrap.checkpoint
      writeCloudWorkspaceCheckpoint(cloudApiBaseUrl, response.workspace.id, response.sync_bootstrap.checkpoint)
      cloudWorkspaces = [
        response.workspace,
        ...cloudWorkspaces.filter((workspace) => workspace.id !== response.workspace.id),
      ]
      selectedCloudWorkspaceId = response.workspace.id
      writeCloudWorkspaceLink(cloudApiBaseUrl, selectedWorkspace.id, response.workspace.id)

      const operations = await buildWorkspaceSyncOperations(selectedWorkspace.id)
      if (operations.length > 0) {
        cloudLastPush = await pushCloudWorkspaceOperations(
          cloudApiBaseUrl,
          session.accessToken,
          response.workspace.id,
          {
            clientId: response.sync_bootstrap.client_id,
            baseCheckpoint: response.sync_bootstrap.checkpoint,
            operations,
          },
        )
        cloudSyncCheckpoint = cloudLastPush.checkpoint
      }

      notice = `Published "${selectedWorkspace.name}" to Slinger Cloud.`
      error = null
      await loadCloudWorkspaceDetails(response.workspace.id)
    } catch (err) {
      console.error(err)
      error = err instanceof Error ? err.message : 'Unable to publish the workspace.'
    } finally {
      cloudPublishBusy = false
    }
  }

  async function loadWorkspaces() {
    try {
      const items = await getWorkspaces()
      workspaces = items
      selectedWorkspaceId = selectedWorkspaceId ?? items[0]?.id ?? null
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to load workspaces from local storage.'
    } finally {
      loadingWorkspaces = false
    }
  }

  function cloudPushErrorMessage(err: unknown, remoteWorkspace: CloudWorkspace | null): string {
    if (
      err instanceof CloudApiError &&
      err.status === 403 &&
      (err.code === 'workspace_access_denied' || err.code === 'forbidden')
    ) {
      const targetName = remoteWorkspace?.name ?? 'the selected remote workspace'
      return `You are not authorized to push to ${targetName}. Ask a workspace owner or admin for editor access or higher.`
    }

    return err instanceof Error ? err.message : 'Unable to push local data to the cloud.'
  }

  async function loadCollections(workspaceId: string) {
    const token = ++collectionsLoadToken
    loadingCollections = true

    try {
      const items = await getCollections(workspaceId)
      if (token !== collectionsLoadToken) return

      collections = items
      selectedCollectionId =
        selectedCollectionId && items.some((collection) => collection.id === selectedCollectionId)
          ? selectedCollectionId
          : items[0]?.id ?? null
      error = null
    } catch (err) {
      console.error(err)
      if (token === collectionsLoadToken) error = 'Unable to load collections for this workspace.'
    } finally {
      if (token === collectionsLoadToken) loadingCollections = false
    }
  }

  async function loadEnvironments(workspaceId: string) {
    const token = ++environmentsLoadToken

    try {
      const defaultEnvironment = await ensureDefaultEnvironment(workspaceId)
      const items = await getEnvironments(workspaceId)
      if (token !== environmentsLoadToken) return

      const nextItems =
        items.length > 0 && items.some((environment) => environment.id === defaultEnvironment.id)
          ? items
          : [defaultEnvironment, ...items]
      environments = nextItems
      selectedEnvironmentId =
        selectedEnvironmentId && nextItems.some((environment) => environment.id === selectedEnvironmentId)
          ? selectedEnvironmentId
          : defaultEnvironment.id
      error = null
    } catch (err) {
      console.error(err)
      if (token === environmentsLoadToken) error = 'Unable to load environments for this workspace.'
    }
  }

  async function loadVariables(environmentId: string) {
    const token = ++variablesLoadToken

    try {
      const items = await getEnvironmentVariables(environmentId)
      if (token === variablesLoadToken) environmentVariables = items
    } catch (err) {
      console.error(err)
      if (token === variablesLoadToken) error = 'Unable to load environment variables.'
    }
  }

  async function loadCollectionTree(collectionId: string) {
    const token = ++collectionTreeLoadToken
    loadingRequests = true

    try {
      const [folderItems, requestItems] = await Promise.all([
        getFolders(collectionId),
        getRequests(collectionId),
      ])
      if (token !== collectionTreeLoadToken) return

      folders = folderItems
      requests = requestItems
      openFolderIds = new Set(folderItems.map((folder) => folder.id))
      openRequestTabs = openRequestTabs.map((tab) => {
        const loadedRequest = requestItems.find((request) => request.id === tab.request.id)
        if (!loadedRequest) return tab

        return {
          ...tab,
          request: tab.savedRequest ? tab.request : loadedRequest,
          savedRequest: loadedRequest,
        }
      })
      error = null
    } catch (err) {
      console.error(err)
      if (token === collectionTreeLoadToken) error = 'Unable to load requests for this collection.'
    } finally {
      if (token === collectionTreeLoadToken) loadingRequests = false
    }
  }

  async function handleCreateWorkspace(event: SubmitEvent) {
    event.preventDefault()
    const name = workspaceName.trim()
    if (!name) return

    try {
      const workspace = await createWorkspace(name)
      workspaces = [...workspaces, workspace]
      selectedWorkspaceId = workspace.id
      workspaceName = ''
      notice = `Workspace "${workspace.name}" created.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to create workspace.'
    }
  }

  async function handleCreateCollection(event: SubmitEvent) {
    event.preventDefault()
    const name = collectionName.trim()
    if (!name || !selectedWorkspaceId) return

    try {
      const collection = await createCollection(selectedWorkspaceId, name)
      collections = [...collections, collection]
      selectedCollectionId = collection.id
      collectionName = ''
      notice = `Collection "${collection.name}" created.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to create collection.'
    }
  }

  async function handleRenameCollection(collection: Collection) {
    const nextName = window.prompt('Collection name', collection.name)
    if (nextName === null) return

    const trimmed = nextName.trim()
    if (!trimmed || trimmed === collection.name) return

    try {
      const renamed = await renameCollection(collection.id, trimmed)
      collections = collections.map((item) => (item.id === renamed.id ? renamed : item))
      notice = `Collection renamed to "${renamed.name}".`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to rename collection.'
    }
  }

  async function handleDeleteCollection(collection: Collection) {
    const confirmed = await askForConfirmation({
      message: `Delete "${collection.name}" and its requests?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      await deleteCollection(collection.id)
      const next = collections.filter((item) => item.id !== collection.id)
      const nextTabs = openRequestTabs.filter((tab) => tab.request.collection_id !== collection.id)
      cancelRequests(
        openRequestTabs
          .filter((tab) => tab.request.collection_id === collection.id)
          .map((tab) => tab.request.id),
      )
      collections = next
      openRequestTabs = nextTabs
      if (selectedRequest?.collection_id === collection.id) {
        selectedRequestId = nextTabs[0]?.request.id ?? null
      }
      if (selectedCollectionId === collection.id) {
        selectedCollectionId = next[0]?.id ?? null
      }
      notice = `Collection "${collection.name}" deleted.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to delete collection.'
    }
  }

  async function handleDeleteRequest(request: ApiRequest) {
    const openTab = openRequestTabs.find((tab) => tab.request.id === request.id)
    const hasUnsavedChanges = openTab ? requestTabHasChanges(openTab) : false
    const confirmed = await askForConfirmation({
      message: hasUnsavedChanges
        ? `Delete "${request.name}" and discard its unsaved changes?`
        : `Delete "${request.name}"?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      await deleteRequest(request.id)
      const tabIndex = openRequestTabs.findIndex((tab) => tab.request.id === request.id)
      const nextTabs = openRequestTabs.filter((tab) => tab.request.id !== request.id)

      cancelRequest(request.id)
      requests = requests.filter((item) => item.id !== request.id)
      openRequestTabs = nextTabs

      if (selectedResponseRequestId === request.id) {
        selectedResponseRequestId = null
        selectedResponseIndex = -1
      }

      if (selectedRequestId === request.id) {
        selectedRequestId =
          nextTabs[Math.max(0, tabIndex - 1)]?.request.id ??
          nextTabs[0]?.request.id ??
          null
      }

      notice = `Request "${request.name}" deleted.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to delete request.'
    }
  }

  async function handleRenameRequest(request: ApiRequest) {
    const nextName = window.prompt('Request name', request.name)
    if (nextName === null) return

    const trimmed = nextName.trim()
    if (!trimmed || trimmed === request.name) return

    try {
      const renamed = await renameRequest(request.id, trimmed)
      requests = requests.map((item) => (item.id === renamed.id ? renamed : item))
      openRequestTabs = openRequestTabs.map((tab) => {
        if (tab.request.id !== renamed.id) return tab

        return {
          ...tab,
          request: requestWithName(tab.request, renamed.name),
          savedRequest: tab.savedRequest ? renamed : tab.savedRequest,
        }
      })
      notice = `Request renamed to "${renamed.name}".`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to rename request.'
    }
  }

  function safeDownloadName(name: string): string {
    return (
      name
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        .slice(0, 80) || 'collection'
    )
  }

  function withJsonExtension(value: string): string {
    return value.toLowerCase().endsWith('.json') ? value : `${value}.json`
  }

  function defaultCollectionExportFileName(collection: Collection): string {
    return `${safeDownloadName(collection.name)}.postman_collection.json`
  }

  function downloadTextFile(fileName: string, contents: string, mimeType: string) {
    const blob = new Blob([contents], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function browserSaveFilePicker(): BrowserSaveFilePicker | null {
    const currentWindow = window as Window & {
      showSaveFilePicker?: BrowserSaveFilePicker
    }

    return currentWindow.showSaveFilePicker ?? null
  }

  function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError'
  }

  async function buildCollectionExportPayload(collection: Collection): Promise<string> {
    const [folderItems, requestItems] = await Promise.all([
      getFolders(collection.id),
      getRequests(collection.id),
    ])

    return exportPostmanCollection({
      collection,
      folders: folderItems,
      requests: requestItems,
    })
  }

  async function handleExportCollection(collection: Collection) {
    const fileName = defaultCollectionExportFileName(collection)

    try {
      if (isTauriRuntime) {
        const defaultPath = await getDefaultExportPath(fileName)
        const chosen = await showSaveDialog({
          defaultPath,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!chosen) return

        const exportPath = withJsonExtension(chosen)
        const payload = await buildCollectionExportPayload(collection)
        await writeExportFile(exportPath, payload)
        notice = `Exported "${collection.name}" to ${exportPath}.`
        error = null
        return
      }

      const saveFilePicker = browserSaveFilePicker()
      if (saveFilePicker) {
        const fileHandle = await saveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: 'Postman collection JSON',
              accept: {
                'application/json': ['.json'],
              },
            },
          ],
        })
        const payload = await buildCollectionExportPayload(collection)
        const writable = await fileHandle.createWritable()
        await writable.write(payload)
        await writable.close()
        notice = `Exported "${collection.name}" to ${fileHandle.name ?? fileName}.`
        error = null
        return
      }

      const targetFileName = await askForExportDestination({
        collectionName: collection.name,
        defaultValue: fileName,
        mode: 'file',
      })
      if (!targetFileName) return

      const payload = await buildCollectionExportPayload(collection)
      const downloadName = withJsonExtension(safeDownloadName(targetFileName))
      downloadTextFile(downloadName, payload, 'application/json;charset=utf-8')
      notice = `Exported "${collection.name}" as ${downloadName}.`
      error = null
    } catch (err) {
      if (isAbortError(err)) return

      console.error(err)
      error = 'Unable to export that collection.'
    }
  }

  async function handleRunCollection(collection: Collection) {
    try {
      const allRequests = await getRequests(collection.id)
      collectionRunner = { collection, requests: allRequests }
    } catch {
      error = 'Unable to load collection requests.'
    }
  }

  async function runRequestForCollection(request: ApiRequest): Promise<{ status?: number; duration_ms?: number; error?: string }> {
    const doc = parseDocument(request)
    const body = typeof doc.body?.raw === 'string' ? doc.body.raw : ''
    const hdrs = requestHeaders(doc)

    const built = buildResolvedRequest({
      method: request.method,
      url: request.url,
      body,
      headers: hdrs,
      auth: doc.auth,
      variables: environmentVariables,
    })

    if (built.missingVariables.length > 0) {
      return { error: `Unresolved: ${built.missingVariables.map((n) => `{{${n}}}`).join(', ')}` }
    }

    try {
      const result = await executeHttpRequest({
        method: built.method,
        url: built.url,
        headers: built.headers,
        body: built.body || null,
      })
      return { status: result.status, duration_ms: result.duration_ms }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function handleImportFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !selectedWorkspaceId) return

    try {
      const payload = await file.text()
      const result = await importPostmanCollection(selectedWorkspaceId, payload)

      collections = [...collections, result.collection]
      selectedCollectionId = result.collection.id
      folders = result.folders
      requests = result.requests
      openFolderIds = new Set(result.folders.map((folder) => folder.id))
      if (result.requests[0]) {
        openRequestTabs = [
          ...openRequestTabs,
          createRequestTabState(result.requests[0], result.requests[0]),
        ]
        selectedRequestId = result.requests[0].id
      }
      notice = `Imported "${result.collection.name}" with ${result.requests.length} requests.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to import that Postman collection.'
    } finally {
      input.value = ''
    }
  }

  async function handleCreateEnvironment(event: SubmitEvent) {
    event.preventDefault()
    const name = environmentName.trim()
    if (!name || !selectedWorkspaceId) return

    try {
      const environment = await createEnvironment(selectedWorkspaceId, name)
      environments = [...environments, environment]
      selectedEnvironmentId = environment.id
      environmentName = ''
      notice = `Environment "${environment.name}" created.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to create environment.'
    }
  }

  async function handleSaveVariable(event: SubmitEvent) {
    event.preventDefault()
    if (!selectedEnvironmentId || !variableKey.trim()) return

    try {
      const variable = await upsertEnvironmentVariable(
        selectedEnvironmentId,
        variableKey,
        variableValue,
      )
      const exists = environmentVariables.some((item) => item.id === variable.id)
      environmentVariables = exists
        ? environmentVariables.map((item) => (item.id === variable.id ? variable : item))
        : [...environmentVariables, variable]
      variableKey = ''
      variableValue = ''
      notice = `Saved {{${variable.key}}}.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to save environment variable.'
    }
  }

  async function setEnvironmentVariable(key: string, value: string) {
    if (!selectedEnvironmentId) {
      error = 'Select an environment first.'
      return
    }

    try {
      const variable = await upsertEnvironmentVariable(selectedEnvironmentId, key, value)
      const exists = environmentVariables.some((item) => item.id === variable.id)
      environmentVariables = exists
        ? environmentVariables.map((item) => (item.id === variable.id ? variable : item))
        : [...environmentVariables, variable]
      notice = `Saved {{${variable.key}}}.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to save environment variable.'
    }
  }

  async function setScriptEnvironmentVariable(
    environmentId: string | null,
    key: string,
    value: unknown,
  ): Promise<void> {
    if (!environmentId) {
      throw new Error('Select an environment before setting variables from a response script.')
    }

    const trimmedKey = key.trim()
    if (!trimmedKey) {
      throw new Error('Environment variable name cannot be empty.')
    }

    const variable = await upsertEnvironmentVariable(environmentId, trimmedKey, String(value ?? ''))

    if (selectedEnvironmentId === environmentId) {
      const exists = environmentVariables.some((item) => item.id === variable.id)
      environmentVariables = exists
        ? environmentVariables.map((item) => (item.id === variable.id ? variable : item))
        : [...environmentVariables, variable]
    }
  }

  async function handleDeleteVariable(variable: EnvironmentVariable) {
    try {
      await deleteEnvironmentVariable(variable.id)
      environmentVariables = environmentVariables.filter((item) => item.id !== variable.id)
      notice = `Deleted {{${variable.key}}}.`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to delete environment variable.'
    }
  }

  function handleEditVariable(variable: EnvironmentVariable) {
    variableKey = variable.key
    variableValue = variable.value
  }

  function selectEnvironmentFromSidebar(id: string | null) {
    selectedEnvironmentId = id
    rightUtilityTab = 'environment'
    rightSidebarOpen = true
  }

  function createClientId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function createInitialRequestDocument(name: string): RequestDocument {
    return {
      name,
      method: 'GET',
      url: '',
      headers: headersWithDefaultPresets([]),
      body: {
        mode: 'raw',
        raw: '',
      },
      auth: null,
      scripts: [],
      responses: [],
    }
  }

  async function handleCreateRequestDraft() {
    if (!selectedWorkspaceId) {
      error = 'Select a workspace before creating a request.'
      return
    }

    const id = `draft-${createClientId()}`
    const name = 'Untitled Request'
    const document = createInitialRequestDocument(name)
    const request = {
      id,
      workspace_id: selectedWorkspaceId,
      collection_id: selectedCollectionId ?? '',
      folder_id: null,
      name,
      method: 'GET',
      url: '',
      document_json: JSON.stringify(document),
      created_at: Math.floor(Date.now() / 1000),
    }
    openRequestTabs = [
      ...openRequestTabs,
      createRequestTabState(request, null),
    ]
    selectedRequestId = id
    error = null
  }

  function setRequestMethod(method: string) {
    methodDraft = method
    updateSelectedRequestDraft({ method })
  }

  function setRequestUrlDraft(value: string) {
    urlDraft = value
    updateSelectedRequestDraft({ url: value })
  }

  function setRequestBodyDraft(value: string) {
    bodyDraft = value
    updateSelectedRequestDraft({ body: value })
  }

  function setRequestScript(listener: ScriptListener, value: string) {
    updateSelectedRequestDraft({ scripts: { [listener]: value } })
  }

  function setRequestPayloadContentType(type: PayloadContentType) {
    requestContentType = type
    updateSelectedRequestDraft({ contentType: type })
  }

  function setRequestHeaders(nextHeaders: HeaderDocument[]) {
    const detectedContentType = payloadContentTypeFromHeaders(nextHeaders)
    if (detectedContentType) requestContentType = detectedContentType

    updateSelectedRequestDraft({ headers: nextHeaders })
  }

  function setRequestAuth(auth: RequestAuthDocument | null) {
    updateSelectedRequestDraft({ auth, headers })
  }

  function headersWithContentType(
    currentHeaders: HeaderDocument[],
    contentType: PayloadContentType,
  ): HeaderDocument[] {
    const value = REQUEST_CONTENT_TYPE_HEADER[contentType]
    const contentTypeIndex = currentHeaders.findIndex(
      (header) => header.key?.toLowerCase() === 'content-type',
    )

    if (contentTypeIndex < 0) {
      return [...currentHeaders, { key: 'Content-Type', value }]
    }

    return currentHeaders.map((header, index) =>
      index === contentTypeIndex
        ? { ...header, key: header.key?.trim() || 'Content-Type', value }
        : header,
    )
  }

  function savedRequestDocument(name = selectedRequest?.name ?? 'Untitled Request'): RequestDocument {
    return {
      ...selectedDocument,
      name,
      method: methodDraft,
      url: urlDraft,
      headers,
      body: {
        ...(selectedDocument.body ?? {}),
        mode: selectedDocument.body?.mode ?? 'raw',
        raw: bodyDraft,
      },
    }
  }

  function requestHeadersSnapshot(headersToSave: HeaderDocument[]): HeaderDocument[] {
    return headersToSave
      .filter((header) => header.key?.trim())
      .map((header) => ({
        ...header,
        key: header.key?.trim() ?? '',
        value: header.value ?? '',
      }))
  }

  function responseStatusLabel(response: HttpResponseData): string {
    const statusText = response.status_text.trim()
    return statusText ? `${response.status} ${statusText}` : String(response.status)
  }

  async function handleSaveRequest() {
    if (!selectedRequest || !requestHasChanges || savingRequest) return

    if (isDraftRequest) {
      const target = await askForRequestSaveTarget({
        requestName: selectedRequest.name || 'Untitled Request',
        selectedCollectionId: selectedCollectionId ?? collections[0]?.id ?? null,
      })
      if (!target) return

      const collection = collections.find((item) => item.id === target.collectionId)
      if (!collection) {
        error = 'Select a collection to save this request.'
        return
      }

      savingRequest = true

      try {
        const document = savedRequestDocument(target.name)
        const created = await createRequest({
          workspaceId: collection.workspace_id,
          collectionId: target.collectionId,
          name: target.name,
          method: methodDraft,
          url: urlDraft,
          documentJson: JSON.stringify(document),
        })
        const savedInCurrentCollection = selectedCollectionId === created.collection_id

        openRequestTabs = openRequestTabs.map((tab) =>
          tab.request.id === selectedRequest.id
            ? {
                ...tab,
                request: created,
                savedRequest: created,
              }
            : tab,
        )
        selectedRequestId = created.id
        if (savedInCurrentCollection) {
          requests = [...requests, created]
        } else {
          selectedCollectionId = created.collection_id
        }
        notice = `Saved "${created.name}".`
        error = null
      } catch (err) {
        console.error(err)
        error = 'Unable to save request.'
      } finally {
        savingRequest = false
      }

      return
    }

    savingRequest = true

    try {
      const document = savedRequestDocument(selectedRequest.name)
      const updated = await updateRequest({
        requestId: selectedRequest.id,
        name: selectedRequest.name,
        method: methodDraft,
        url: urlDraft,
        documentJson: JSON.stringify(document),
      })

      requests = requests.map((request) =>
        request.id === updated.id ? updated : request,
      )
      updateSelectedRequestTab(updated, updated)
      notice = `Saved "${updated.name}".`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to save request.'
    } finally {
      savingRequest = false
    }
  }

  function responseNameExists(name: string, responses = responseExamples): boolean {
    const normalized = name.trim().toLowerCase()
    return responses.some((response) => (response.name ?? '').trim().toLowerCase() === normalized)
  }

  async function handleSaveResponse() {
    const requestToSave = selectedRequest
    const responseToSave = sendResult
    const documentSnapshot = selectedDocument
    const headersSnapshot = headers
    const methodSnapshot = methodDraft
    const urlSnapshot = urlDraft
    const bodySnapshot = bodyDraft
    const existingResponses = responseExamples

    if (!requestToSave || !responseToSave || savingResponse) return

    if (isDraftRequest) {
      error = 'Save the request before saving a response.'
      return
    }

    const responseName = await askForResponseName(
      existingResponses.flatMap((response) => (response.name ? [response.name] : [])),
    )
    if (!responseName) return

    if (responseNameExists(responseName, existingResponses)) {
      error = 'A response with this name already exists.'
      return
    }

    savingResponse = true

    try {
      const document: RequestDocument = {
        ...documentSnapshot,
        name: requestToSave.name,
        method: methodSnapshot,
        url: urlSnapshot,
        headers: headersSnapshot,
        body: {
          ...(documentSnapshot.body ?? {}),
          mode: documentSnapshot.body?.mode ?? 'raw',
          raw: bodySnapshot,
        },
      }
      const responses = requestResponses(document)

      if (responseNameExists(responseName, responses)) {
        error = 'A response with this name already exists.'
        return
      }

      const nextResponse = {
        name: responseName,
        originalRequest: {
          method: methodSnapshot,
          header: requestHeadersSnapshot(headersSnapshot),
          url: urlSnapshot,
          body: document.body ?? null,
          auth: document.auth ?? null,
          description: document.description ?? null,
        },
        responseTime: responseToSave.duration_ms,
        status: responseStatusLabel(responseToSave),
        code: responseToSave.status,
        header: responseToSave.headers,
        body: responseToSave.body,
      }
      const nextDocument = {
        ...document,
        responses: [...responses, nextResponse],
      }
      const updated = await updateRequest({
        requestId: requestToSave.id,
        method: methodSnapshot,
        url: urlSnapshot,
        documentJson: JSON.stringify(nextDocument),
      })

      requests = requests.map((request) =>
        request.id === updated.id ? updated : request,
      )
      updateSelectedRequestTab(updated, updated)
      if (selectedRequestId === requestToSave.id) {
        selectedResponseIndex = responses.length
        selectedResponseRequestId = updated.id
        sendResult = null
        updateRequestTabResponse(updated.id, {
          sendResult: null,
          sendError: null,
        })
        responseViewTab = 'body'
      }
      notice = `Saved response "${responseName}".`
      error = null
    } catch (err) {
      console.error(err)
      error = 'Unable to save response.'
    } finally {
      savingResponse = false
    }
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
    if (!selectedRequest) return

    event.preventDefault()
    void handleSaveRequest()
  }

  function handleBeautifyBody() {
    if (!bodyDraft.trim()) return

    const formatted = formatPayload(bodyDraft, requestContentType)
    if (!formatted.ok) {
      error = 'Body is not valid JSON, so it cannot be beautified.'
      return
    }

    setRequestBodyDraft(formatted.value)
    error = null
  }

  function encodeBase64(value: string): string {
    const bytes = new TextEncoder().encode(value)
    let binary = ''

    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }

    return btoa(binary)
  }

  function appendQueryParams(url: string, params: AuthQueryParam[]): string {
    const queryParams = params.filter((param) => param.key.trim())
    if (queryParams.length === 0) return url

    const hashIndex = url.indexOf('#')
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
    const separator = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'
    const query = queryParams
      .map((param) => `${encodeURIComponent(param.key.trim())}=${encodeURIComponent(param.value)}`)
      .join('&')

    return `${base}${separator}${query}${hash}`
  }

  function normalizeRequestUrlForHeaders(url: string): string {
    const trimmed = url.trim()
    if (!trimmed) return trimmed
    if (trimmed.startsWith('//')) return `http:${trimmed}`
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed
    return `http://${trimmed}`
  }

  function requestHostHeader(url: string): string | null {
    try {
      return new URL(normalizeRequestUrlForHeaders(url)).host
    } catch {
      return null
    }
  }

  function byteLength(value: string): number {
    return new TextEncoder().encode(value).length
  }

  function addMissingPresetHeaders(
    headers: Array<{ key: string; value: string }>,
    existingHeaders: HeaderDocument[],
  ): Array<{ key: string; value: string }> {
    const existingKeys = new Set(existingHeaders.map(normalizedHeaderKey).filter(Boolean))
    const missingHeaders = DEFAULT_REQUEST_HEADERS
      .filter((header) => !existingKeys.has(normalizedHeaderKey(header)))
      .map((header) => ({
        key: header.key ?? '',
        value: header.value ?? '',
      }))

    return [...headers, ...missingHeaders]
  }

  function isAutoHeaderValue(value: string): boolean {
    return value.trim().toLowerCase() === '<auto>' || value.trim().toLowerCase() === 'auto'
  }

  function applyAutoHeaders(
    headers: Array<{ key: string; value: string }>,
    url: string,
    body: string,
  ): Array<{ key: string; value: string }> {
    const host = requestHostHeader(url)

    return headers.flatMap((header) => {
      const key = header.key.toLowerCase()
      if (!AUTO_REQUEST_HEADER_KEYS.has(key) || !isAutoHeaderValue(header.value)) return [header]
      if (key === 'host') return host ? [{ ...header, value: host }] : []
      if (key === 'content-length') return [{ ...header, value: byteLength(body).toString() }]
      return [header]
    })
  }

  function mergeRequestHeaders(
    baseHeaders: Array<{ key: string; value: string }>,
    authHeaders: HeaderDocument[],
  ): Array<{ key: string; value: string }> {
    const normalizedAuthHeaders = authHeaders
      .filter((header) => header.key?.trim())
      .map((header) => ({
        key: header.key?.trim() ?? '',
        value: header.value ?? '',
      }))
    const authHeaderKeys = new Set(normalizedAuthHeaders.map((header) => header.key.toLowerCase()))

    return [
      ...baseHeaders.filter((header) => !authHeaderKeys.has(header.key.toLowerCase())),
      ...normalizedAuthHeaders,
    ]
  }

  function buildResolvedRequest(input: BuildResolvedRequestInput): BuiltRequest {
    const requestStartedAt = input.now ?? new Date()
    const resolvedUrl = resolveTemplate(input.url, input.variables, requestStartedAt)
    const resolvedBody = resolveTemplate(input.body, input.variables, requestStartedAt)
    const resolvedManualHeaders = input.headers
      .filter((header) => !header.disabled && header.key?.trim())
      .map((header) => ({
        key: resolveTemplate(header.key?.trim() ?? '', input.variables, requestStartedAt),
        value: resolveTemplate(header.value ?? '', input.variables, requestStartedAt),
      }))
    const resolvedAuthValues = requestAuthTemplateValues(input.auth).map((value) =>
      resolveTemplate(value, input.variables, requestStartedAt),
    )
    const authParts = requestAuthParts(
      input.auth,
      (value) => resolveTemplate(value, input.variables, requestStartedAt),
      encodeBase64,
    )
    const resolvedUrlWithAuth = appendQueryParams(resolvedUrl, authParts.queryParams)
    const presetHeaders = addMissingPresetHeaders(resolvedManualHeaders, input.headers)
    const resolvedHeaders = applyAutoHeaders(
      mergeRequestHeaders(presetHeaders, authParts.headers),
      resolvedUrlWithAuth,
      resolvedBody,
    )
    const missingVariables = unresolvedVariables([
      resolvedUrlWithAuth,
      resolvedBody,
      ...resolvedAuthValues,
      ...resolvedHeaders.flatMap((header) => [header.key, header.value]),
    ])

    return {
      method: input.method,
      url: resolvedUrlWithAuth,
      headers: resolvedHeaders,
      body: resolvedBody,
      missingVariables,
    }
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`
  }

  function curlCommandFromBuiltRequest(request: BuiltRequest): string {
    const parts = [
      `curl --request ${request.method.trim().toUpperCase() || 'GET'} ${shellQuote(request.url)}`,
      ...request.headers.map((header) => `  --header ${shellQuote(`${header.key}: ${header.value}`)}`),
    ]

    if (request.body) {
      parts.push(`  --data ${shellQuote(request.body)}`)
    }

    return parts.join(' \\\n')
  }

  function fallbackCopyText(value: string): boolean {
    const textArea = document.createElement('textarea')
    textArea.value = value
    textArea.style.position = 'fixed'
    textArea.style.left = '-9999px'
    textArea.style.top = '0'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    try {
      return document.execCommand('copy')
    } finally {
      document.body.removeChild(textArea)
    }
  }

  async function copyText(value: string) {
    if (!value) return

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }

    if (!fallbackCopyText(value)) {
      throw new Error('Clipboard copy failed')
    }
  }

  async function copyBuiltRequest(): Promise<boolean> {
    try {
      await copyText(copyRequestCurl)
      notice = 'Copied request as cURL.'
      error = null
      return true
    } catch (err) {
      console.error(err)
      error = 'Unable to copy request.'
      return false
    }
  }

  function headerValue(headers: Array<{ key: string; value: string }>, key: string): string | null {
    const match = headers.find((header) => header.key.toLowerCase() === key.toLowerCase())
    return match?.value ?? null
  }

  function headersObject(headers: Array<{ key: string; value: string }>): Record<string, string> {
    return headers.reduce<Record<string, string>>((result, header) => {
      result[header.key] = header.value
      return result
    }, {})
  }

  function scriptRequestHeaders(
    headers: Array<{ key?: string; value?: string }>,
  ): Array<{ key: string; value: string }> {
    return headers
      .map((header) => {
        const key = header.key?.trim() ?? ''
        if (!key) return null

        return {
          key,
          value: header.value ?? '',
        }
      })
      .filter((header): header is { key: string; value: string } => header !== null)
  }

  function createScriptRequestContext(request: {
    method: string
    url: string
    body: string
    headers: Array<{ key: string; value: string }>
  }) {
    return {
      method: request.method,
      url: request.url,
      body: request.body,
      headers: {
        all: () => headersObject(request.headers),
        get: (key: string) => headerValue(request.headers, key),
      },
    }
  }

  function withRuntimeEnvironmentVariable(
    variables: EnvironmentVariable[],
    environmentId: string | null,
    key: string,
    value: unknown,
  ): EnvironmentVariable[] {
    const nextValue = String(value ?? '')
    const existing = variables.find((variable) => variable.key === key)

    if (existing) {
      return variables.map((variable) =>
        variable.key === key ? { ...variable, value: nextValue } : variable,
      )
    }

    return [
      ...variables,
      {
        id: `runtime-${key}`,
        environment_id: environmentId ?? '',
        key,
        value: nextValue,
        created_at: 0,
      },
    ]
  }

  async function runRequestScripts(options: {
    document: RequestDocument
    listener: ScriptListener
    environmentId: string | null
    request?: {
      method: string
      url: string
      body: string
      headers: Array<{ key: string; value: string }>
    }
    response?: HttpResponseData
    variables: EnvironmentVariable[]
  }): Promise<EnvironmentVariable[]> {
    const script = scriptTextForListener(requestScripts(options.document), options.listener)
    if (!script.trim()) return options.variables

    let parsedJson: unknown
    let hasParsedJson = false
    const pendingEnvironmentWrites: Array<Promise<void>> = []
    let runtimeVariables = [...options.variables]
    const request = options.request ? createScriptRequestContext(options.request) : null
    const response = {
      status: options.response?.status ?? 0,
      statusText: options.response?.status_text ?? '',
      duration: options.response?.duration_ms ?? 0,
      body: options.response?.body ?? '',
      text: () => options.response?.body ?? '',
      json: () => {
        if (!hasParsedJson) {
          parsedJson = JSON.parse(options.response?.body || 'null')
          hasParsedJson = true
        }

        return parsedJson
      },
      headers: {
        all: () => headersObject(options.response?.headers ?? []),
        get: (key: string) => headerValue(options.response?.headers ?? [], key),
      },
    }
    const env = {
      get: (key: string) =>
        runtimeVariables.find((variable) => variable.key === key)?.value ?? null,
      set: (key: string, value: unknown) => {
        const trimmedKey = key.trim()
        if (trimmedKey) {
          runtimeVariables = withRuntimeEnvironmentVariable(
            runtimeVariables,
            options.environmentId,
            trimmedKey,
            value,
          )
        }

        const write = setScriptEnvironmentVariable(options.environmentId, key, value)
        pendingEnvironmentWrites.push(write)
        return write
      },
    }
    const pm = {
      request,
      response,
      environment: env,
      variables: env,
      test: (_name: string, assertion: () => void) => assertion(),
    }
    const runner = new Function(
      'request',
      'response',
      'env',
      'pm',
      'console',
      '"use strict"; return (async () => {\n' + script + '\n})()',
    ) as (
      request: typeof request,
      response: typeof response,
      env: typeof env,
      pm: typeof pm,
      consoleApi: Console,
    ) => Promise<unknown>

    await runner(request, response, env, pm, console)
    await Promise.all(pendingEnvironmentWrites)
    return runtimeVariables
  }

  async function handleSend() {
    if (!selectedRequest) return

    const requestId = selectedRequest.id
    if (requestAbortControllers.has(requestId)) return

    const abortController = new AbortController()
    const requestRunId = createClientId()
    requestAbortControllers.set(requestId, abortController)
    const responseContentTypeAtSend = responseContentType
    const documentAtSend = selectedDocument
    const environmentIdAtSend = selectedEnvironmentId
    const variablesAtSend = environmentVariables
    setRequestSending(requestId, true)
    sendResult = null
    sendError = null
    selectedResponseRequestId = null
    updateRequestTabResponse(requestId, {
      sendResult: null,
      sendError: null,
    })

    try {
      let variablesAfterPreRequest = variablesAtSend
      try {
        variablesAfterPreRequest = await runRequestScripts({
          document: documentAtSend,
          listener: 'prerequest',
          environmentId: environmentIdAtSend,
          request: {
            method: methodDraft,
            url: urlDraft,
            body: bodyDraft,
            headers: scriptRequestHeaders(headers),
          },
          variables: variablesAtSend,
        })
      } catch (scriptErr) {
        const message = scriptErr instanceof Error ? scriptErr.message : String(scriptErr)
        throw new Error(`Pre-request script failed: ${message}`)
      }
      if (abortController.signal.aborted || requestAbortControllers.get(requestId) !== abortController) return

      const builtRequest = buildResolvedRequest({
        method: methodDraft,
        url: urlDraft,
        body: bodyDraft,
        headers,
        auth: selectedDocument.auth,
        variables: variablesAfterPreRequest,
      })

      if (builtRequest.missingVariables.length > 0) {
        throw new Error(
          `Unresolved variables: ${builtRequest.missingVariables.map((name) => `{{${name}}}`).join(', ')}`,
        )
      }

      const result = await executeHttpRequest({
        method: builtRequest.method,
        url: builtRequest.url,
        headers: builtRequest.headers,
        body: builtRequest.body,
      }, abortController.signal, requestRunId)
      if (abortController.signal.aborted || requestAbortControllers.get(requestId) !== abortController) return

      const detectedContentType = payloadContentTypeFromHeaders(result.headers)
      const nextResponseContentType = detectedContentType ?? responseContentTypeAtSend

      updateRequestTabResponse(requestId, {
        sendResult: result,
        sendError: null,
        responseContentType: nextResponseContentType,
      })
      if (selectedRequestId === requestId) {
        sendResult = result
        responseContentType = nextResponseContentType
      }

      try {
        await runRequestScripts({
          document: documentAtSend,
          listener: 'test',
          request: builtRequest,
          response: result,
          environmentId: environmentIdAtSend,
          variables: variablesAfterPreRequest,
        })
        if (abortController.signal.aborted || requestAbortControllers.get(requestId) !== abortController) return
        error = null
      } catch (scriptErr) {
        if (abortController.signal.aborted || requestAbortControllers.get(requestId) !== abortController) return
        const message = scriptErr instanceof Error ? scriptErr.message : String(scriptErr)
        console.error('Post-request script failed:', message)
        error = `Post-request script failed: ${message}`
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) return

      const nextSendError = normalizeRequestError(err)
      updateRequestTabResponse(requestId, {
        sendResult: null,
        sendError: nextSendError,
      })
      if (selectedRequestId === requestId) {
        sendError = nextSendError
      }
    } finally {
      if (requestAbortControllers.get(requestId) === abortController) {
        requestAbortControllers.delete(requestId)
        setRequestSending(requestId, false)
      }
    }
  }

  function normalizeRequestError(err: unknown): string {
    const rawMessage = err instanceof Error ? err.message : String(err)
    console.error('Request failed:', rawMessage)

    if (rawMessage.toLowerCase().includes('connection refused') || rawMessage.includes('os error 111')) {
      return 'Connection refused'
    }

    if (
      rawMessage.toLowerCase().includes('dns error') ||
      rawMessage.toLowerCase().includes('failed to lookup address')
    ) {
      return 'DNS resolution failed'
    }

    if (rawMessage.toLowerCase().includes('timeout')) {
      return 'Request timed out'
    }

    return rawMessage
  }

  function toggleFolder(folderId: string) {
    const next = new Set(openFolderIds)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    openFolderIds = next
  }

  async function closeRequestTab(requestId: string) {
    const tabIndex = openRequestTabs.findIndex((tab) => tab.request.id === requestId)
    const tab = openRequestTabs[tabIndex]
    if (!tab) return

    if (requestTabHasChanges(tab)) {
      const requestName = tab.request.name || 'this request'
      const confirmed = await askForConfirmation({
        message: `Discard unsaved changes to "${requestName}" and close the request tab?`,
        confirmLabel: 'Close',
        tone: 'danger',
      })
      if (!confirmed) return
    }

    cancelRequest(requestId)

    const nextTabs = openRequestTabs.filter((item) => item.request.id !== requestId)
    openRequestTabs = nextTabs

    if (selectedRequestId === requestId) {
      selectedRequestId =
        nextTabs[Math.max(0, tabIndex - 1)]?.request.id ??
        nextTabs[0]?.request.id ??
        null
    }
  }

  async function closeAllRequestTabs() {
    const tabsToClose = [...openRequestTabs]
    const modifiedTabs = tabsToClose.filter(requestTabHasChanges)
    const unmodifiedTabIds = new Set(
      tabsToClose
        .filter((tab) => !requestTabHasChanges(tab))
        .map((tab) => tab.request.id),
    )

    if (unmodifiedTabIds.size > 0) {
      cancelRequests([...unmodifiedTabIds])
      const nextTabs = openRequestTabs.filter((tab) => !unmodifiedTabIds.has(tab.request.id))
      openRequestTabs = nextTabs

      if (selectedRequestId && unmodifiedTabIds.has(selectedRequestId)) {
        selectedRequestId = nextTabs[0]?.request.id ?? null
      }
    }

    for (const tab of modifiedTabs) {
      const stillOpen = openRequestTabs.some((item) => item.request.id === tab.request.id)
      if (!stillOpen) continue

      const requestName = tab.request.name || 'this request'
      const confirmed = await askForConfirmation({
        message: `Discard unsaved changes to "${requestName}" and close the request tab?`,
        confirmLabel: 'Close',
        tone: 'danger',
      })
      if (!confirmed) return

      cancelRequest(tab.request.id)
      const nextTabs = openRequestTabs.filter((item) => item.request.id !== tab.request.id)
      openRequestTabs = nextTabs

      if (selectedRequestId === tab.request.id) {
        selectedRequestId = nextTabs[0]?.request.id ?? null
      }
    }
  }
</script>

<main class="h-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
  <Header
    selectedRequest={selectedRequest}
    {rightSidebarOpen}
    toggleRightSidebar={() => (rightSidebarOpen = !rightSidebarOpen)}
  />
  <Toolbar
    {workspaces}
    {selectedWorkspaceId}
    setSelectedWorkspaceId={(id) => (selectedWorkspaceId = id)}
    {loadingWorkspaces}
    {workspaceName}
    setWorkspaceName={(value) => (workspaceName = value)}
    {handleCreateWorkspace}
    {theme}
    setTheme={(value) => (theme = value)}
    {orientation}
    setOrientation={(value) => (orientation = value)}
  />

  <div class="flex h-[calc(100vh-92px)] min-h-0 overflow-hidden">
    <div class="relative flex min-w-0 min-h-0 h-full">
      <div class="flex-shrink-0 h-full" style="width: {sidebarWidth}px; min-width: 280px; max-width: 720px;">
        <Sidebar
          {handleImportFile}
          {handleCreateCollection}
          {collectionName}
          setCollectionName={(value) => (collectionName = value)}
          {selectedWorkspace}
          {environments}
          {selectedEnvironmentId}
          setSelectedEnvironmentId={selectEnvironmentFromSidebar}
          {isTauriRuntime}
          {error}
          {loadingCollections}
          {collections}
          {loadingRequests}
          {foldersByParent}
          {requestsByFolder}
          {selectedCollectionId}
          setSelectedCollectionId={(id) => (selectedCollectionId = id)}
          {selectedRequestId}
          {selectedResponseRequestId}
          {selectedResponseIndex}
          setSelectedRequestId={selectRequest}
          {selectResponseExample}
          {openFolderIds}
          {toggleFolder}
          {handleRenameCollection}
          {handleDeleteCollection}
          {handleRenameRequest}
          {handleDeleteRequest}
          {handleExportCollection}
          {handleRunCollection}
        />
      </div>

      <div
        class="sidebar-resizer"
        on:pointerdown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize collections pane"
      />
    </div>

    <RequestPane
      {activeTab}
      {bodyDraft}
      {bodyIsValid}
      {description}
      {handleBeautifyBody}
      handleCancelSend={() => selectedRequestId && cancelRequest(selectedRequestId)}
      {handleCreateRequestDraft}
      {handleSend}
      {handleSaveResponse}
      {headers}
      {methodDraft}
      {orientation}
      {params}
      {requestContentType}
      {responseContentType}
      {responseViewTab}
      openRequestTabs={openRequestTabItems}
      {scripts}
      selectedCollection={selectedRequestCollection}
      {selectedDocument}
      {selectedRequest}
      {selectedRequestId}
      {selectedResponse}
      {sendError}
      {sendResult}
      {sending}
      {savingResponse}
      setActiveTab={(tab) => (activeTab = tab)}
      setAuth={setRequestAuth}
      setBodyDraft={setRequestBodyDraft}
      setHeaders={setRequestHeaders}
      setRequestContentType={setRequestPayloadContentType}
      setResponseViewTab={(tab) => (responseViewTab = tab)}
      setSelectedRequestId={selectRequest}
      setScript={setRequestScript}
      setRequestMethod={setRequestMethod}
      {closeRequestTab}
      {closeAllRequestTabs}
      setEnvironmentVariable={setEnvironmentVariable}
      environmentVariables={environmentVariables}
      selectedEnvironmentId={selectedEnvironmentId}
      setUrlDraft={setRequestUrlDraft}
      {urlDraft}
      builtRequest={builtCopyRequest}
    />

    <RightUtilitySidebar
      open={rightSidebarOpen}
      setOpen={(open) => (rightSidebarOpen = open)}
      activeTab={rightUtilityTab}
      setActiveTab={(tab) => (rightUtilityTab = tab)}
      {selectedRequest}
      copyFormat={copyRequestFormat}
      setCopyFormat={(format) => (copyRequestFormat = format)}
      curlCommand={copyRequestCurl}
      missingVariables={copyRequestMissingVariables}
      {copyBuiltRequest}
      {selectedWorkspace}
      {environments}
      {selectedEnvironmentId}
      setSelectedEnvironmentId={(id) => (selectedEnvironmentId = id)}
      {environmentName}
      setEnvironmentName={(value) => (environmentName = value)}
      {handleCreateEnvironment}
      {environmentVariables}
      {variableKey}
      setVariableKey={(value) => (variableKey = value)}
      {variableValue}
      setVariableValue={(value) => (variableValue = value)}
      {handleSaveVariable}
      {handleEditVariable}
      {handleDeleteVariable}
      cloudApiBaseUrl={cloudApiBaseUrl}
      setCloudApiBaseUrl={(value) => (cloudApiBaseUrl = value)}
      cloudDeviceName={cloudDeviceName}
      setCloudDeviceName={(value) => (cloudDeviceName = value)}
      {saveCloudConfig}
      {cloudUser}
      {cloudWorkspaces}
      {cloudBusy}
      cloudPublishBusy={cloudPublishBusy}
      cloudDeviceFlow={cloudDeviceFlow}
      {selectedCloudWorkspaceId}
      setSelectedCloudWorkspaceId={setSelectedCloudWorkspaceSelection}
      {selectedCloudWorkspace}
      {startCloudSignIn}
      {pollCloudSignIn}
      refreshCloudState={() => refreshCloudState(false)}
      refreshCloudWorkspaceDetails={() =>
        selectedCloudWorkspaceId ? loadCloudWorkspaceDetails(selectedCloudWorkspaceId) : Promise.resolve()
      }
      {signOutCloud}
      openAdminUiHint="Admins create users, assign workspace access, and create remote workspaces from the admin UI before desktop sign-in."
      {pushWorkspaceSync}
      {pullWorkspaceSync}
      {publishWorkspaceToCloud}
    />
  </div>

  {#if confirmation}
    <ConfirmDialog
      message={confirmation.message}
      confirmLabel={confirmation.confirmLabel}
      tone={confirmation.tone}
      on:confirm={() => finishConfirmation(true)}
      on:cancel={() => finishConfirmation(false)}
    />
  {/if}

  {#if saveRequestDialog}
    <SaveRequestDialog
      {collections}
      requestName={saveRequestDialog.requestName}
      selectedCollectionId={saveRequestDialog.selectedCollectionId}
      on:save={(event) => finishRequestSaveDialog(event.detail)}
      on:cancel={() => finishRequestSaveDialog(null)}
    />
  {/if}

  {#if saveResponseDialog}
    <SaveResponseDialog
      existingNames={saveResponseDialog.existingNames}
      on:save={(event) => finishResponseSaveDialog(event.detail)}
      on:cancel={() => finishResponseSaveDialog(null)}
    />
  {/if}

  {#if exportCollectionDialog}
    <ExportCollectionDialog
      collectionName={exportCollectionDialog.collectionName}
      defaultValue={exportCollectionDialog.defaultValue}
      mode={exportCollectionDialog.mode}
      on:export={(event) => finishExportCollectionDialog(event.detail)}
      on:cancel={() => finishExportCollectionDialog(null)}
    />
  {/if}

  {#if collectionRunner}
    <CollectionRunnerDialog
      collection={collectionRunner.collection}
      requests={collectionRunner.requests}
      runRequest={runRequestForCollection}
      onClose={() => (collectionRunner = null)}
    />
  {/if}

  <Toast message={notice} on:dismiss={() => (notice = null)} />
</main>

<style>
  .sidebar-resizer {
    width: 9px;
    cursor: col-resize;
    background: transparent;
    transition: background-color 0.15s ease;
  }

  .sidebar-resizer:hover,
  .sidebar-resizer:active {
    background: rgba(148, 163, 184, 0.12);
  }
</style>
