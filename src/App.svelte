<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import Header from './components/Header.svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import RequestPane from './components/RequestPane.svelte'
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
    extractParams,
    parseDocument,
    payloadContentTypeFromHeaders,
    requestHeaders,
    requestResponses,
    requestScripts,
    resolveTemplate,
    scriptText,
    unresolvedVariables,
    type ActiveTab,
    type HeaderDocument,
    type RequestDocument,
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
    deleteCollection,
    deleteEnvironmentVariable,
    ensureDefaultEnvironment,
    executeHttpRequest,
    getCollections,
    getEnvironmentVariables,
    getEnvironments,
    getFolders,
    getRequests,
    getWorkspaces,
    importPostmanCollection,
    isTauriRuntime,
    renameCollection,
    updateRequest,
    upsertEnvironmentVariable,
  } from './tauri'

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
  type RequestTabState = {
    request: ApiRequest
    savedRequest: ApiRequest | null
  }
  type RequestTabItem = {
    id: string
    name: string
    method: string
    hasChanges: boolean
  }
  const REQUEST_CONTENT_TYPE_HEADER: Record<PayloadContentType, string> = {
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    text: 'text/plain',
    binary: 'application/octet-stream',
  }

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

  let collectionsLoadToken = 0
  let environmentsLoadToken = 0
  let variablesLoadToken = 0
  let collectionTreeLoadToken = 0
  let lastWorkspaceId: string | null | undefined
  let lastEnvironmentId: string | null | undefined
  let lastCollectionId: string | null | undefined
  let lastRequestId: string | null | undefined

  $: selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null
  $: selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null
  $: selectedRequestTab = openRequestTabs.find((tab) => tab.request.id === selectedRequestId) ?? null
  $: isDraftRequest = Boolean(selectedRequestTab && !selectedRequestTab.savedRequest)
  $: selectedRequest = selectedRequestTab?.request ?? null
  $: selectedSavedRequest = selectedRequestTab?.savedRequest ?? null
  $: selectedRequestCollection =
    collections.find((collection) => collection.id === selectedRequest?.collection_id) ??
    selectedCollection
  $: selectedDocument = parseDocument(selectedRequest)
  $: headers = requestHeaders(selectedDocument)
  $: responseExamples = requestResponses(selectedDocument)
  $: selectedResponse =
    selectedResponseRequestId === selectedRequestId
      ? responseExamples[selectedResponseIndex] ?? null
      : null
  $: bodyFormat = formatPayload(bodyDraft, requestContentType)
  $: bodyIsValid = bodyFormat.ok && !/\{\{[^}]+\}\}/.test(bodyDraft)
  $: selectedSavedDocument = parseDocument(selectedSavedRequest)
  $: savedRequestBody = selectedSavedDocument.body?.raw ?? ''
  $: savedRequestContentType = payloadContentTypeFromHeaders(requestHeaders(selectedSavedDocument)) ?? 'json'
  $: savedRequestMethod = selectedSavedDocument.method ?? selectedSavedRequest?.method ?? ''
  $: requestHasChanges = Boolean(
    selectedRequestTab &&
      (!selectedSavedRequest ||
        urlDraft !== selectedSavedRequest.url ||
        bodyDraft !== savedRequestBody ||
        requestContentType !== savedRequestContentType ||
        methodDraft !== savedRequestMethod),
  )
  $: openRequestTabItems = openRequestTabs.map(tabStateToItem)
  $: params = extractParams(urlDraft, selectedDocument)
  $: scripts = scriptText(requestScripts(selectedDocument))
  $: description =
    typeof selectedDocument.description === 'string' ? selectedDocument.description.trim() : ''
  $: resolvedUrlPreview = resolveTemplate(urlDraft, environmentVariables)
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
    if (selectedWorkspaceId !== lastWorkspaceId) {
      lastWorkspaceId = selectedWorkspaceId

      if (!selectedWorkspaceId) {
        collectionsLoadToken += 1
        environmentsLoadToken += 1
        collections = []
        environments = []
        environmentVariables = []
        selectedCollectionId = null
        selectedEnvironmentId = null
        openRequestTabs = []
        selectedRequestId = null
        selectedResponseRequestId = null
      } else {
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
    const requestId = selectedRequest?.id ?? null

    if (requestId !== lastRequestId) {
      lastRequestId = requestId
      const currentDocument = parseDocument(selectedRequest)
      const rawBody = currentDocument.body?.raw ?? ''
      methodDraft = selectedRequest?.method ?? 'GET'
      urlDraft = selectedRequest?.url ?? ''
      bodyDraft = rawBody
      requestContentType = payloadContentTypeFromHeaders(requestHeaders(currentDocument)) ?? 'json'
      sendResult = null
      sendError = null
      activeTab = isDraftRequest || rawBody ? 'Body' : 'Docs'
    }
  }

  onMount(() => {
    void loadWorkspaces()
    window.addEventListener('keydown', handleGlobalKeydown, true)
  })

  onDestroy(() => {
    stopResize()
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

  function requestTabHasChanges(tab: RequestTabState): boolean {
    const savedRequest = tab.savedRequest
    if (!savedRequest) return true

    const draftDocument = parseDocument(tab.request)
    const savedDocument = parseDocument(savedRequest)
    const draftBody = draftDocument.body?.raw ?? ''
    const savedBody = savedDocument.body?.raw ?? ''
    const draftContentType = payloadContentTypeFromHeaders(requestHeaders(draftDocument)) ?? 'json'
    const savedContentType = payloadContentTypeFromHeaders(requestHeaders(savedDocument)) ?? 'json'
    const draftMethod = draftDocument.method ?? tab.request.method
    const savedMethod = savedDocument.method ?? savedRequest.method

    return (
      tab.request.url !== savedRequest.url ||
      draftBody !== savedBody ||
      draftContentType !== savedContentType ||
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
      {
        request,
        savedRequest: request,
      },
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
    responseViewTab = 'body'

    const responseHeaders = Array.isArray(response.header) ? response.header : []
    const detectedContentType = payloadContentTypeFromHeaders(responseHeaders)
    responseContentType = detectedContentType ?? responseContentType
  }

  function updateSelectedRequestTab(request: ApiRequest, savedRequest?: ApiRequest | null) {
    openRequestTabs = openRequestTabs.map((tab) =>
      tab.request.id === request.id
        ? {
            request,
            savedRequest: savedRequest === undefined ? tab.savedRequest : savedRequest,
          }
        : tab,
    )
  }

  function editableRequestDocument(
    request: ApiRequest,
    values: {
      method: string
      url: string
      body: string
      contentType: PayloadContentType
      name?: string
    },
  ): RequestDocument {
    const document = parseDocument(request)

    return {
      ...document,
      name: values.name ?? document.name ?? request.name,
      method: values.method,
      url: values.url,
      headers: headersWithContentType(requestHeaders(document), values.contentType),
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
    name?: string
  }) {
    if (!selectedRequest) return

    const nextMethod = values.method ?? methodDraft
    const nextUrl = values.url ?? urlDraft
    const nextBody = values.body ?? bodyDraft
    const nextContentType = values.contentType ?? requestContentType
    const nextName = values.name ?? selectedRequest.name
    const nextDocument = editableRequestDocument(selectedRequest, {
      method: nextMethod,
      url: nextUrl,
      body: nextBody,
      contentType: nextContentType,
      name: nextName,
    })
    const nextRequest = {
      ...selectedRequest,
      name: nextName,
      method: nextMethod,
      url: nextUrl,
      document_json: JSON.stringify(nextDocument),
    }

    updateSelectedRequestTab(nextRequest)
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
          {
            request: result.requests[0],
            savedRequest: result.requests[0],
          },
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
      headers: [],
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
      {
        request,
        savedRequest: null,
      },
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

  function setRequestPayloadContentType(type: PayloadContentType) {
    requestContentType = type
    updateSelectedRequestDraft({ contentType: type })
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
      headers: headersWithContentType(headers, requestContentType),
      body: {
        ...(selectedDocument.body ?? {}),
        mode: selectedDocument.body?.mode ?? 'raw',
        raw: bodyDraft,
      },
    }
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
    const contentTypeSnapshot = requestContentType
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
        headers: headersWithContentType(headersSnapshot, contentTypeSnapshot),
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
        status: responseToSave.status_text,
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

  async function handleSend() {
    if (!selectedRequest) return

    sending = true
    sendResult = null
    sendError = null
    selectedResponseRequestId = null

    try {
      const resolvedUrl = resolveTemplate(urlDraft, environmentVariables)
      const resolvedBody = resolveTemplate(bodyDraft, environmentVariables)
      const resolvedHeaders = headers
        .filter((header) => !header.disabled && header.key?.trim())
        .map((header) => ({
          key: resolveTemplate(header.key?.trim() ?? '', environmentVariables),
          value: resolveTemplate(header.value ?? '', environmentVariables),
        }))
      const missingVariables = unresolvedVariables([
        resolvedUrl,
        resolvedBody,
        ...resolvedHeaders.flatMap((header) => [header.key, header.value]),
      ])

      if (missingVariables.length > 0) {
        throw new Error(
          `Unresolved variables: ${missingVariables.map((name) => `{{${name}}}`).join(', ')}`,
        )
      }

      const result = await executeHttpRequest({
        method: methodDraft,
        url: resolvedUrl,
        headers: resolvedHeaders,
        body: resolvedBody,
      })
      const detectedContentType = payloadContentTypeFromHeaders(result.headers)
      if (detectedContentType) responseContentType = detectedContentType

      sendResult = result
    } catch (err) {
      sendError = normalizeRequestError(err)
    } finally {
      sending = false
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

      const nextTabs = openRequestTabs.filter((item) => item.request.id !== tab.request.id)
      openRequestTabs = nextTabs

      if (selectedRequestId === tab.request.id) {
        selectedRequestId = nextTabs[0]?.request.id ?? null
      }
    }
  }
</script>

<main class="h-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
  <Header selectedRequest={selectedRequest} />
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
      {handleCreateRequestDraft}
      {handleSend}
      {handleSaveRequest}
      {handleSaveResponse}
      {headers}
      {methodDraft}
      {orientation}
      {params}
      {requestContentType}
      {resolvedUrlPreview}
      {responseContentType}
      {responseViewTab}
      {requestHasChanges}
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
      {savingRequest}
      {savingResponse}
      setActiveTab={(tab) => (activeTab = tab)}
      setBodyDraft={setRequestBodyDraft}
      setRequestContentType={setRequestPayloadContentType}
      setResponseViewTab={(tab) => (responseViewTab = tab)}
      setSelectedRequestId={selectRequest}
      setRequestMethod={setRequestMethod}
      {closeRequestTab}
      {closeAllRequestTabs}
      setEnvironmentVariable={setEnvironmentVariable}
      environmentVariables={environmentVariables}
      selectedEnvironmentId={selectedEnvironmentId}
      setUrlDraft={setRequestUrlDraft}
      {urlDraft}
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
