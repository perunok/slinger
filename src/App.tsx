import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import Header from './components/Header'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import RequestPane from './components/RequestPane'
import {
  ApiFolder,
  ApiRequest,
  Collection,
  HttpResponseData,
  Workspace,
  createCollection,
  createWorkspace,
  deleteCollection,
  executeHttpRequest,
  getCollections,
  getFolders,
  getRequests,
  getWorkspaces,
  importPostmanCollection,
  isTauriRuntime,
  renameCollection,
} from './tauri'

type ActiveTab = 'Docs' | 'Params' | 'Authorization' | 'Headers' | 'Body' | 'Scripts' | 'Settings'

type HeaderDocument = {
  key?: string
  value?: string
  disabled?: boolean
}

type ResponseExample = {
  name?: string
  status?: string
  code?: number
  body?: string
}

type ScriptEvent = {
  listen?: string
  script?: {
    exec?: string[] | string
  }
}

type RequestDocument = {
  description?: string | null
  headers?: HeaderDocument[]
  body?: {
    mode?: string
    raw?: string
  } | null
  auth?: unknown
  scripts?: ScriptEvent[]
  responses?: ResponseExample[]
  source?: {
    request?: {
      url?: {
        variable?: Array<{ key?: string; value?: string; description?: string }>
      }
    }
  }
}

type RequestParam = {
  key: string
  value: string
  source: string
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
const ROOT_ID = '__root__'

const METHOD_STYLES: Record<string, string> = {
  GET: 'text-emerald-400',
  POST: 'text-amber-300',
  PUT: 'text-sky-300',
  PATCH: 'text-violet-300',
  DELETE: 'text-rose-300',
  HEAD: 'text-stone-300',
  OPTIONS: 'text-cyan-300',
}

function parseDocument(request: ApiRequest | null): RequestDocument {
  if (!request) return {}

  try {
    return JSON.parse(request.document_json) as RequestDocument
  } catch {
    return {}
  }
}

function formatMaybeJson(value: string): string {
  if (!value.trim()) return ''

  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function methodClass(method: string): string {
  return METHOD_STYLES[method.toUpperCase()] ?? 'text-slate-300'
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 'bg-[#1e3a2a] text-[#8de1a6]'
  if (status >= 400) return 'bg-[#3a1717] text-[#ffb3b3]'
  return 'bg-[#2f2f2f] text-[#d8d8d8]'
}

function editorLines(value: string): string[] {
  return value ? value.split('\n') : ['']
}

function sortByCreated<T extends { created_at: number; id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.created_at !== right.created_at) return left.created_at - right.created_at
    return left.id.localeCompare(right.id)
  })
}

function requestHeaders(document: RequestDocument): HeaderDocument[] {
  return Array.isArray(document.headers) ? document.headers : []
}

function requestResponses(document: RequestDocument): ResponseExample[] {
  return Array.isArray(document.responses) ? document.responses : []
}

function requestScripts(document: RequestDocument): ScriptEvent[] {
  return Array.isArray(document.scripts) ? document.scripts : []
}

function extractParams(url: string, document: RequestDocument): RequestParam[] {
  const params: RequestParam[] = []
  const queryIndex = url.indexOf('?')

  if (queryIndex >= 0) {
    const query = url.slice(queryIndex + 1).split('#')[0]
    for (const part of query.split('&')) {
      if (!part) continue
      const [rawKey, rawValue = ''] = part.split('=')
      params.push({
        key: decodeURIComponent(rawKey),
        value: decodeURIComponent(rawValue),
        source: 'query',
      })
    }
  }

  const variables = document.source?.request?.url?.variable
  if (Array.isArray(variables)) {
    for (const variable of variables) {
      if (!variable.key) continue
      params.push({
        key: variable.key,
        value: variable.value ?? '',
        source: 'path',
      })
    }
  }

  return params
}

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function scriptText(events: ScriptEvent[]): string {
  const lines: string[] = []

  for (const event of events) {
    const exec = event.script?.exec
    if (!exec) continue
    lines.push(`// ${event.listen ?? 'script'}`)
    lines.push(...(Array.isArray(exec) ? exec : [exec]))
  }

  return lines.join('\n')
}

function App() {
  const importInputRef = useRef<HTMLInputElement>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [folders, setFolders] = useState<ApiFolder[]>([])
  const [requests, setRequests] = useState<ApiRequest[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState<ActiveTab>('Body')
  const [urlDraft, setUrlDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [sendResult, setSendResult] = useState<HttpResponseData | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')
  const [collectionName, setCollectionName] = useState('')
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true)
  const [loadingCollections, setLoadingCollections] = useState(false)
  const [loadingRequests, setLoadingRequests] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [responseHeight, setResponseHeight] = useState(260)
  const [isResizingResponse, setIsResizingResponse] = useState(false)
  const [responseWidth, setResponseWidth] = useState(420)
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>(() => {
    const saved = window.localStorage.getItem('slinger-orientation')
    return saved === 'horizontal' ? 'horizontal' : 'vertical'
  })
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = window.localStorage.getItem('slinger-theme')
    return saved === 'light' ? 'light' : 'dark'
  })
  const [selectedResponseIndex, setSelectedResponseIndex] = useState(0)
  const responseSplitRef = useRef<HTMLDivElement>(null)

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  )
  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  )
  const selectedRequest = useMemo(
    () => requests.find((request) => request.id === selectedRequestId) ?? null,
    [requests, selectedRequestId],
  )
  const selectedDocument = useMemo(() => parseDocument(selectedRequest), [selectedRequest])
  const headers = useMemo(() => requestHeaders(selectedDocument), [selectedDocument])
  const responseExamples = useMemo(() => requestResponses(selectedDocument), [selectedDocument])
  const selectedResponse = responseExamples[selectedResponseIndex] ?? responseExamples[0] ?? null

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!isResizingResponse || !responseSplitRef.current) return
      const rect = responseSplitRef.current.getBoundingClientRect()

      if (orientation === 'vertical') {
        const newHeight = rect.bottom - event.clientY
        const minHeight = 120
        const maxHeight = rect.height - 120

        setResponseHeight(Math.max(minHeight, Math.min(maxHeight, newHeight)))
      } else {
        const newWidth = rect.right - event.clientX
        const minWidth = 200
        const maxWidth = rect.width - 200

        setResponseWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)))
      }
    }

    function handlePointerUp() {
      setIsResizingResponse(false)
    }

    if (isResizingResponse) {
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerUp)
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [isResizingResponse])

  useEffect(() => {
    window.localStorage.setItem('slinger-orientation', orientation)
  }, [orientation])

  useEffect(() => {
    if (responseExamples.length === 0) {
      setSelectedResponseIndex(0)
      return
    }

    setSelectedResponseIndex((current) => (current >= responseExamples.length ? 0 : current))
  }, [responseExamples.length])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('slinger-theme', theme)
  }, [theme])

  const selectedResponseBody = selectedResponse?.body ? formatMaybeJson(selectedResponse.body) : ''
  const params = useMemo(() => extractParams(urlDraft, selectedDocument), [selectedDocument, urlDraft])
  const scripts = useMemo(() => scriptText(requestScripts(selectedDocument)), [selectedDocument])
  const description =
    typeof selectedDocument.description === 'string' ? selectedDocument.description.trim() : ''

  const foldersByParent = useMemo(() => {
    const groups = new Map<string, ApiFolder[]>()

    for (const folder of sortByCreated(folders)) {
      const parentId = folder.parent_folder_id ?? ROOT_ID
      groups.set(parentId, [...(groups.get(parentId) ?? []), folder])
    }

    return groups
  }, [folders])

  const requestsByFolder = useMemo(() => {
    const groups = new Map<string, ApiRequest[]>()

    for (const request of sortByCreated(requests)) {
      const folderId = request.folder_id ?? ROOT_ID
      groups.set(folderId, [...(groups.get(folderId) ?? []), request])
    }

    return groups
  }, [requests])

  useEffect(() => {
    let ignore = false

    async function loadWorkspaces() {
      try {
        const items = await getWorkspaces()
        if (ignore) return

        setWorkspaces(items)
        setSelectedWorkspaceId((current) => current ?? items[0]?.id ?? null)
        setError(null)
      } catch (err) {
        console.error(err)
        if (!ignore) setError('Unable to load workspaces from local storage.')
      } finally {
        if (!ignore) setLoadingWorkspaces(false)
      }
    }

    loadWorkspaces()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setCollections([])
      setSelectedCollectionId(null)
      return
    }

    const workspaceId = selectedWorkspaceId
    let ignore = false

    async function loadCollections() {
      setLoadingCollections(true)

      try {
        const items = await getCollections(workspaceId)
        if (ignore) return

        setCollections(items)
        setSelectedCollectionId((current) => {
          if (current && items.some((collection) => collection.id === current)) return current
          return items[0]?.id ?? null
        })
        setError(null)
      } catch (err) {
        console.error(err)
        if (!ignore) setError('Unable to load collections for this workspace.')
      } finally {
        if (!ignore) setLoadingCollections(false)
      }
    }

    loadCollections()

    return () => {
      ignore = true
    }
  }, [selectedWorkspaceId])

  useEffect(() => {
    if (!selectedCollectionId) {
      setFolders([])
      setRequests([])
      setSelectedRequestId(null)
      return
    }

    const collectionId = selectedCollectionId
    let ignore = false

    async function loadCollectionTree() {
      setLoadingRequests(true)

      try {
        const [folderItems, requestItems] = await Promise.all([
          getFolders(collectionId),
          getRequests(collectionId),
        ])
        if (ignore) return

        setFolders(folderItems)
        setRequests(requestItems)
        setOpenFolderIds(new Set(folderItems.map((folder) => folder.id)))
        setSelectedRequestId((current) => {
          if (current && requestItems.some((request) => request.id === current)) return current
          return requestItems[0]?.id ?? null
        })
        setError(null)
      } catch (err) {
        console.error(err)
        if (!ignore) setError('Unable to load requests for this collection.')
      } finally {
        if (!ignore) setLoadingRequests(false)
      }
    }

    loadCollectionTree()

    return () => {
      ignore = true
    }
  }, [selectedCollectionId])

  useEffect(() => {
    const rawBody = selectedDocument.body?.raw ?? ''
    setUrlDraft(selectedRequest?.url ?? '')
    setBodyDraft(rawBody)
    setSendResult(null)
    setSendError(null)
    setActiveTab(rawBody ? 'Body' : 'Docs')
  }, [selectedDocument, selectedRequest])

  async function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = workspaceName.trim()
    if (!name) return

    try {
      const workspace = await createWorkspace(name)
      setWorkspaces((current) => [...current, workspace])
      setSelectedWorkspaceId(workspace.id)
      setWorkspaceName('')
      setNotice(`Workspace "${workspace.name}" created.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to create workspace.')
    }
  }

  async function handleCreateCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = collectionName.trim()
    if (!name || !selectedWorkspaceId) return

    try {
      const collection = await createCollection(selectedWorkspaceId, name)
      setCollections((current) => [...current, collection])
      setSelectedCollectionId(collection.id)
      setCollectionName('')
      setNotice(`Collection "${collection.name}" created.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to create collection.')
    }
  }

  async function handleRenameCollection(collection: Collection) {
    const nextName = window.prompt('Collection name', collection.name)
    if (nextName === null) return

    const trimmed = nextName.trim()
    if (!trimmed || trimmed === collection.name) return

    try {
      const renamed = await renameCollection(collection.id, trimmed)
      setCollections((current) =>
        current.map((item) => (item.id === renamed.id ? renamed : item)),
      )
      setNotice(`Collection renamed to "${renamed.name}".`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to rename collection.')
    }
  }

  async function handleDeleteCollection(collection: Collection) {
    const confirmed = window.confirm(`Delete "${collection.name}" and its requests?`)
    if (!confirmed) return

    try {
      await deleteCollection(collection.id)
      setCollections((current) => {
        const next = current.filter((item) => item.id !== collection.id)
        if (selectedCollectionId === collection.id) {
          setSelectedCollectionId(next[0]?.id ?? null)
        }
        return next
      })
      setNotice(`Collection "${collection.name}" deleted.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to delete collection.')
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (!file || !selectedWorkspaceId) return

    try {
      const payload = await file.text()
      const result = await importPostmanCollection(selectedWorkspaceId, payload)

      setCollections((current) => [...current, result.collection])
      setSelectedCollectionId(result.collection.id)
      setFolders(result.folders)
      setRequests(result.requests)
      setOpenFolderIds(new Set(result.folders.map((folder) => folder.id)))
      setSelectedRequestId(result.requests[0]?.id ?? null)
      setNotice(`Imported "${result.collection.name}" with ${result.requests.length} requests.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to import that Postman collection.')
    } finally {
      event.currentTarget.value = ''
    }
  }

  async function handleSend() {
    if (!selectedRequest) return

    setSending(true)
    setSendResult(null)
    setSendError(null)

    try {
      const result = await executeHttpRequest({
        method: selectedRequest.method,
        url: urlDraft,
        headers: headers
          .filter((header) => !header.disabled && header.key?.trim())
          .map((header) => ({
            key: header.key?.trim() ?? '',
            value: header.value ?? '',
          })),
        body: bodyDraft,
      })

      setSendResult(result)
    } catch (err) {
      console.error(err)
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  function toggleFolder(folderId: string) {
    setOpenFolderIds((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function renderRequestRow(request: ApiRequest, depth = 0) {
    return (
      <button
        key={request.id}
        onClick={() => setSelectedRequestId(request.id)}
        className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${
          request.id === selectedRequestId
            ? 'bg-[var(--surface)] text-[var(--text)]'
            : 'text-[var(--muted)] hover:bg-[var(--panel)]'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span className={`w-12 shrink-0 font-semibold ${methodClass(request.method)}`}>
          {request.method}
        </span>
        <span className="min-w-0 flex-1 truncate">{request.name}</span>
      </button>
    )
  }

  function renderFolder(folder: ApiFolder, depth = 0) {
    const isOpen = openFolderIds.has(folder.id)
    const childFolders = foldersByParent.get(folder.id) ?? []
    const childRequests = requestsByFolder.get(folder.id) ?? []

    return (
      <div key={folder.id}>
        <button
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-[#d8d8d8] hover:bg-[#303030]"
          onClick={() => toggleFolder(folder.id)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span className="w-3 shrink-0 text-[var(--muted)]">{isOpen ? 'v' : '>'}</span>
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        </button>
        {isOpen ? (
          <div className="space-y-1">
            {childFolders.map((child) => renderFolder(child, depth + 1))}
            {childRequests.map((request) => renderRequestRow(request, depth + 1))}
          </div>
        ) : null}
      </div>
    )
  }

  function renderTable(rows: Array<{ key: string; value: string; source?: string }>) {
    if (rows.length === 0) {
      return <div className="px-4 py-4 text-sm text-[var(--muted)]">None</div>
    }

    return (
      <div className="grid grid-cols-[180px_1fr_120px] border-t border-[var(--border)] text-sm">
        {rows.map((row, index) => (
          <div key={`${row.key}-${index}`} className="contents">
            <div className="border-b border-[var(--border)] px-4 py-2 font-mono text-[var(--text)]">{row.key}</div>
            <div className="border-b border-[var(--border)] px-4 py-2 font-mono text-[var(--muted)]">{row.value}</div>
            <div className="border-b border-[var(--border)] px-4 py-2 text-[var(--muted)]">{row.source ?? ''}</div>
          </div>
        ))}
      </div>
    )
  }

  function renderActiveTab() {
    switch (activeTab) {
      case 'Docs':
        return (
          <div className="space-y-4 p-4 text-sm text-[var(--muted)]">
            <h2 className="text-lg font-semibold text-[var(--text)]">{selectedRequest?.name}</h2>
            <p className="max-w-3xl whitespace-pre-wrap text-[var(--muted)]">{description || 'No description'}</p>
            {responseExamples.length > 0 ? (
              <div>
                <h3 className="mb-2 font-semibold text-[var(--text)]">Examples</h3>
                <div className="space-y-2">
                  {responseExamples.map((response, index) => (
                    <div key={`${response.name}-${index}`} className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
                      <span className="font-semibold text-[var(--text)]">{response.name ?? 'Example'}</span>
                      <span className="ml-3 text-[var(--muted)]">{response.status ?? ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )
      case 'Params':
        return renderTable(params)
      case 'Authorization':
        return (
          <pre className="h-full overflow-auto p-4 font-mono text-sm text-[#cbd5e1]">
            {stringifyUnknown(selectedDocument.auth)}
          </pre>
        )
      case 'Headers':
        return renderTable(
          headers.map((header) => ({
            key: header.key ?? '',
            value: header.value ?? '',
            source: header.disabled ? 'disabled' : 'enabled',
          })),
        )
      case 'Scripts':
        return (
          <pre className="h-full overflow-auto p-4 font-mono text-sm text-[#cbd5e1]">
            {scripts || 'No scripts'}
          </pre>
        )
      case 'Settings':
        return renderTable([
          { key: 'Method', value: selectedRequest?.method ?? '' },
          { key: 'URL', value: urlDraft },
          { key: 'Collection', value: selectedCollection?.name ?? '' },
          { key: 'Request ID', value: selectedRequest?.id ?? '' },
        ])
      case 'Body':
      default:
        return (
          <textarea
            value={bodyDraft}
            onChange={(event) => setBodyDraft(event.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-[var(--input)] p-4 font-mono text-[13px] leading-5 text-[var(--text)] outline-none"
          />
        )
    }
  }

  return (
    <main className="h-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <Header selectedRequest={selectedRequest} />
      <Toolbar
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        setSelectedWorkspaceId={setSelectedWorkspaceId}
        loadingWorkspaces={loadingWorkspaces}
        workspaceName={workspaceName}
        setWorkspaceName={setWorkspaceName}
        handleCreateWorkspace={handleCreateWorkspace}
        theme={theme}
        setTheme={setTheme}
        orientation={orientation}
        setOrientation={setOrientation}
      />

      <div className="flex h-[calc(100vh-92px)] min-h-0">
        <Sidebar
          importInputRef={importInputRef}
          handleImportFile={handleImportFile}
          handleCreateCollection={handleCreateCollection}
          collectionName={collectionName}
          setCollectionName={setCollectionName}
          selectedWorkspace={selectedWorkspace}
          isTauriRuntime={isTauriRuntime}
          error={error}
          notice={notice}
          loadingCollections={loadingCollections}
          collections={collections}
          loadingRequests={loadingRequests}
          foldersByParent={foldersByParent}
          requestsByFolder={requestsByFolder}
          selectedCollectionId={selectedCollectionId}
          setSelectedCollectionId={setSelectedCollectionId}
          renderFolder={renderFolder}
          renderRequestRow={renderRequestRow}
          handleRenameCollection={handleRenameCollection}
          handleDeleteCollection={handleDeleteCollection}
        />

        <RequestPane
          selectedRequest={selectedRequest}
          selectedCollection={selectedCollection}
          urlDraft={urlDraft}
          setUrlDraft={setUrlDraft}
          handleSend={handleSend}
          sending={sending}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          bodyDraft={bodyDraft}
          setBodyDraft={setBodyDraft}
          REQUEST_TABS={REQUEST_TABS}
          headers={headers}
          params={params}
          scripts={scripts}
          selectedDocument={selectedDocument}
          renderActiveTab={renderActiveTab}
          responseExamples={responseExamples}
          selectedResponseIndex={selectedResponseIndex}
          setSelectedResponseIndex={setSelectedResponseIndex}
          selectedResponseBody={selectedResponseBody}
          selectedResponse={selectedResponse}
          sendResult={sendResult}
          sendError={sendError}
          responseHeight={responseHeight}
          responseWidth={responseWidth}
          orientation={orientation}
          responseSplitRef={responseSplitRef}
          isResizingResponse={isResizingResponse}
          setIsResizingResponse={setIsResizingResponse}
          formatMaybeJson={formatMaybeJson}
        />
      </div>
    </main>
  )
}

export default App
