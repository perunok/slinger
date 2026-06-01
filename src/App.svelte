<script lang="ts">
  import { onMount } from 'svelte'
  import Header from './components/Header.svelte'
  import RequestPane from './components/RequestPane.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import Toolbar from './components/Toolbar.svelte'
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
  } from './lib/requestDocument'
  import {
    type ApiFolder,
    type ApiRequest,
    type Collection,
    type Environment,
    type EnvironmentVariable,
    type HttpResponseData,
    type Workspace,
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
    upsertEnvironmentVariable,
  } from './tauri'

  type Theme = 'dark' | 'light'
  type Orientation = 'vertical' | 'horizontal'

  let workspaces: Workspace[] = []
  let collections: Collection[] = []
  let folders: ApiFolder[] = []
  let requests: ApiRequest[] = []
  let environments: Environment[] = []
  let environmentVariables: EnvironmentVariable[] = []
  let selectedWorkspaceId: string | null = null
  let selectedCollectionId: string | null = null
  let selectedRequestId: string | null = null
  let selectedEnvironmentId: string | null = null
  let openFolderIds = new Set<string>()
  let activeTab: ActiveTab = 'Body'
  let urlDraft = ''
  let bodyDraft = ''
  let environmentName = ''
  let variableKey = ''
  let variableValue = ''
  let sendResult: HttpResponseData | null = null
  let sendError: string | null = null
  let sending = false
  let workspaceName = ''
  let collectionName = ''
  let loadingWorkspaces = true
  let loadingCollections = false
  let loadingRequests = false
  let error: string | null = null
  let notice: string | null = null
  let orientation: Orientation = window.localStorage.getItem('slinger-orientation') === 'horizontal'
    ? 'horizontal'
    : 'vertical'
  let theme: Theme = window.localStorage.getItem('slinger-theme') === 'light' ? 'light' : 'dark'
  let selectedResponseIndex = 0
  let responseViewTab: 'headers' | 'body' = 'body'
  let requestContentType: PayloadContentType = 'json'
  let responseContentType: PayloadContentType = 'json'
  let responseStatusCode = '200'

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
  $: selectedRequest = requests.find((request) => request.id === selectedRequestId) ?? null
  $: selectedDocument = parseDocument(selectedRequest)
  $: headers = requestHeaders(selectedDocument)
  $: responseExamples = requestResponses(selectedDocument)
  $: selectedResponse = responseExamples[selectedResponseIndex] ?? responseExamples[0] ?? null
  $: bodyFormat = formatPayload(bodyDraft, requestContentType)
  $: bodyIsValid = bodyFormat.ok && !/\{\{[^}]+\}\}/.test(bodyDraft)
  $: params = extractParams(urlDraft, selectedDocument)
  $: scripts = scriptText(requestScripts(selectedDocument))
  $: description =
    typeof selectedDocument.description === 'string' ? selectedDocument.description.trim() : ''
  $: resolvedUrlPreview = resolveTemplate(urlDraft, environmentVariables)
  $: foldersByParent = groupFoldersByParent(folders)
  $: requestsByFolder = groupRequestsByFolder(requests)
  $: if (selectedResponseIndex >= responseExamples.length) {
    selectedResponseIndex = 0
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
      } else {
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
        selectedRequestId = null
      } else {
        void loadCollectionTree(selectedCollectionId)
      }
    }
  }
  $: {
    const requestId = selectedRequest?.id ?? null

    if (requestId !== lastRequestId) {
      lastRequestId = requestId
      const rawBody = selectedDocument.body?.raw ?? ''
      urlDraft = selectedRequest?.url ?? ''
      bodyDraft = rawBody
      requestContentType = payloadContentTypeFromHeaders(requestHeaders(selectedDocument)) ?? 'json'
      sendResult = null
      sendError = null
      activeTab = rawBody ? 'Body' : 'Docs'
    }
  }

  onMount(() => {
    void loadWorkspaces()
  })

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
      selectedRequestId =
        selectedRequestId && requestItems.some((request) => request.id === selectedRequestId)
          ? selectedRequestId
          : requestItems[0]?.id ?? null
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
    const confirmed = window.confirm(`Delete "${collection.name}" and its requests?`)
    if (!confirmed) return

    try {
      await deleteCollection(collection.id)
      const next = collections.filter((item) => item.id !== collection.id)
      collections = next
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
      selectedRequestId = result.requests[0]?.id ?? null
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

  function setRequestMethod(method: string) {
    if (!selectedRequest) return

    requests = requests.map((request) =>
      request.id === selectedRequest.id ? { ...request, method } : request,
    )
  }

  function handleBeautifyBody() {
    if (!bodyDraft.trim()) return

    const formatted = formatPayload(bodyDraft, requestContentType)
    if (!formatted.ok) {
      error = 'Body is not valid JSON, so it cannot be beautified.'
      return
    }

    bodyDraft = formatted.value
    error = null
  }

  async function handleSend() {
    if (!selectedRequest) return

    sending = true
    sendResult = null
    sendError = null

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
        method: selectedRequest.method,
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

  <div class="flex h-[calc(100vh-92px)] min-h-0">
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
      {notice}
      {loadingCollections}
      {collections}
      {loadingRequests}
      {foldersByParent}
      {requestsByFolder}
      {selectedCollectionId}
      setSelectedCollectionId={(id) => (selectedCollectionId = id)}
      {selectedRequestId}
      setSelectedRequestId={(id) => (selectedRequestId = id)}
      {openFolderIds}
      {toggleFolder}
      {handleRenameCollection}
      {handleDeleteCollection}
    />

    <RequestPane
      {activeTab}
      {bodyDraft}
      {bodyIsValid}
      {description}
      {handleBeautifyBody}
      {handleSend}
      {headers}
      {orientation}
      {params}
      {requestContentType}
      {resolvedUrlPreview}
      {responseContentType}
      {responseExamples}
      {responseStatusCode}
      {responseViewTab}
      {scripts}
      {selectedCollection}
      {selectedDocument}
      {selectedRequest}
      {selectedResponse}
      {selectedResponseIndex}
      {sendError}
      {sendResult}
      {sending}
      setActiveTab={(tab) => (activeTab = tab)}
      setBodyDraft={(value) => (bodyDraft = value)}
      setRequestContentType={(type) => (requestContentType = type)}
      setResponseContentType={(type) => (responseContentType = type)}
      setResponseStatusCode={(code) => (responseStatusCode = code)}
      setResponseViewTab={(tab) => (responseViewTab = tab)}
      setSelectedResponseIndex={(index) => (selectedResponseIndex = index)}
      setRequestMethod={setRequestMethod}
      setEnvironmentVariable={setEnvironmentVariable}
      environmentVariables={environmentVariables}
      selectedEnvironmentId={selectedEnvironmentId}
      setUrlDraft={(value) => (urlDraft = value)}
      {urlDraft}
    />
  </div>
</main>
