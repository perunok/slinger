import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
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
      const newHeight = rect.bottom - event.clientY
      const minHeight = 120
      const maxHeight = rect.height - 120

      setResponseHeight(Math.max(minHeight, Math.min(maxHeight, newHeight)))
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
      <header className="flex h-7 items-center border-b border-[var(--border)] bg-[var(--toolbar)] px-3 text-[13px]">
        <div className="flex w-1/3 items-center gap-4 font-medium text-[var(--text)]">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Help</span>
        </div>
        <div className="w-1/3 truncate text-center text-[var(--text)]">
          {selectedRequest ? `${selectedRequest.name} - Slinger` : 'Slinger'}
        </div>
        <div className="flex w-1/3 justify-end gap-3 text-[var(--muted)]">
          <span>Invite</span>
          <span>Upgrade</span>
        </div>
      </header>

      <div className="flex h-16 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-alt)] px-3">
        <div className="flex items-center gap-2 text-[#a8a8a8]">
          <button className="toolbar-button" aria-label="Back">
            &lt;
          </button>
          <button className="toolbar-button" aria-label="Forward">
            &gt;
          </button>
        </div>

        <select
          value={selectedWorkspaceId ?? ''}
          onChange={(event) => setSelectedWorkspaceId(event.target.value || null)}
          className="select-field h-8 w-52 rounded px-2 text-sm outline-none"
          disabled={loadingWorkspaces}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        <form className="flex items-center gap-2" onSubmit={handleCreateWorkspace}>
          <input
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="New workspace"
            className="h-8 w-40 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
          />
          <button className="secondary-button" disabled={!workspaceName.trim()}>
            Add
          </button>
        </form>

        <div className="mx-auto flex h-8 w-[320px] items-center rounded border border-[var(--border)] bg-[var(--panel)] px-3 text-sm text-[var(--muted)]">
          Search
        </div>

        <button
          className="secondary-button"
          type="button"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"></circle>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
          )}
        </button>
        <button className="secondary-button">Save</button>
        <button className="secondary-button">Share</button>
      </div>

      <div className="flex h-[calc(100vh-92px)] min-h-0">
        <aside className="flex w-[385px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-alt)]">
          <div className="border-b border-[var(--border)] p-3">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xs font-bold uppercase tracking-wide text-[var(--text)]">Collections</h1>
              <button
                className="toolbar-button"
                onClick={() => importInputRef.current?.click()}
                disabled={!selectedWorkspaceId}
                title="Import Postman collection"
              >
                Import
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>

            <form className="mt-3 flex gap-2" onSubmit={handleCreateCollection}>
              <input
                value={collectionName}
                onChange={(event) => setCollectionName(event.target.value)}
                placeholder="New collection"
                className="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
                disabled={!selectedWorkspaceId}
              />
              <button
                className="primary-button h-8"
                disabled={!collectionName.trim() || !selectedWorkspaceId}
              >
                +
              </button>
            </form>

            {selectedWorkspace ? (
              <p className="mt-3 truncate text-xs text-[#8c8c8c]">Workspace: {selectedWorkspace.name}</p>
            ) : null}
            {!isTauriRuntime ? (
              <p className="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">
                Browser preview mode: data is stored in localStorage. Run the desktop app for SQLite.
              </p>
            ) : null}
            {error ? <p className="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">{error}</p> : null}
            {notice ? (
              <p className="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">{notice}</p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            {loadingCollections ? (
              <p className="px-2 py-3 text-sm text-[var(--muted)]">Loading collections...</p>
            ) : collections.length === 0 ? (
              <div className="px-2 py-4 text-sm text-[#9a9a9a]">
                Create a collection or import the Postman JSON sample.
              </div>
            ) : (
              collections.map((collection) => {
                const expanded = collection.id === selectedCollectionId
                const rootFolders = foldersByParent.get(ROOT_ID) ?? []
                const rootRequests = requestsByFolder.get(ROOT_ID) ?? []

                return (
                  <div key={collection.id} className="mb-1">
                    <div
                      className={`group flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                        expanded ? 'bg-[var(--surface)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--panel)]'
                      }`}
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setSelectedCollectionId(collection.id)}
                      >
                        <span className="w-3 shrink-0 text-[var(--muted)]">{expanded ? 'v' : '>'}</span>
                        <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                      </button>
                      <button
                        className="rounded px-1 text-[11px] text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] group-hover:opacity-100"
                        onClick={() => handleRenameCollection(collection)}
                      >
                        Rename
                      </button>
                      <button
                        className="rounded px-1 text-[11px] text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] group-hover:opacity-100"
                        onClick={() => handleDeleteCollection(collection)}
                      >
                        Delete
                      </button>
                    </div>

                    {expanded ? (
                      <div className="ml-3 mt-1 space-y-1">
                        {loadingRequests ? (
                          <p className="py-2 text-xs text-[var(--muted)]">Loading requests...</p>
                        ) : requests.length === 0 && folders.length === 0 ? (
                          <p className="py-2 text-xs text-[var(--muted)]">No requests yet.</p>
                        ) : (
                          <>
                            {rootFolders.map((folder) => renderFolder(folder))}
                            {rootRequests.map((request) => renderRequestRow(request))}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>

          <div className="border-t border-[var(--border)] text-xs font-bold uppercase text-[var(--text)]">
            {['Environments', 'Specs', 'Flows'].map((label) => (
              <button
                key={label}
                className="flex h-8 w-full items-center gap-2 border-b border-[var(--border)] px-3 text-left text-[var(--muted)]"
              >
                <span>&gt;</span>
                {label}
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
          <div className="flex h-9 items-end gap-1 border-b border-[var(--border)] bg-[var(--bg-alt)] px-4">
            {selectedRequest ? (
              <button className="h-7 max-w-[260px] truncate rounded-t bg-[var(--surface)] px-4 text-left text-xs text-[var(--text)]">
                <span className={`mr-2 font-semibold ${methodClass(selectedRequest.method)}`}>
                  {selectedRequest.method}
                </span>
                {selectedRequest.name}
              </button>
            ) : (
              <button className="h-7 rounded-t bg-[var(--surface)] px-4 text-xs text-[var(--muted)]">No request selected</button>
            )}
            <button className="h-7 px-3 text-lg text-[var(--muted)]">+</button>
          </div>

          {selectedRequest ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-4 text-sm">
                <span className="text-[var(--muted)]">{selectedCollection?.name}</span>
                <span className="text-[var(--muted)]">&gt;</span>
                <span className="font-semibold text-[var(--text)]">{selectedRequest.name}</span>
              </div>

              <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
                <div
                  className={`flex h-8 w-24 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface)] text-sm font-bold ${methodClass(
                    selectedRequest.method,
                  )}`}
                >
                  {selectedRequest.method}
                </div>
                <input
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  className="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 font-mono text-sm text-[var(--text)] outline-none"
                />
                <button className="primary-button h-8 w-24" onClick={handleSend} disabled={sending}>
                  {sending ? 'Sending' : 'Send'}
                </button>
              </div>

              <div className="flex h-10 items-center gap-6 border-b border-[var(--border)] px-4 text-sm text-[var(--muted)]">
                {REQUEST_TABS.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`h-10 border-b-2 ${
                      tab === activeTab
                        ? 'border-[#f26b3a] font-semibold text-[var(--text)]'
                        : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    {tab}
                    {tab === 'Headers' && headers.length > 0 ? (
                      <span className="ml-1 text-[var(--muted)]">{headers.length}</span>
                    ) : null}
                  </button>
                ))}
              </div>

              {activeTab === 'Body' ? (
                <div className="flex h-10 items-center gap-4 border-b border-[var(--border)] px-4 text-sm text-[var(--muted)]">
                  {['none', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary', 'GraphQL'].map((item) => (
                    <label key={item} className="flex items-center gap-2">
                      <span
                        className={`h-3 w-3 rounded-full border ${
                          item === (selectedDocument.body?.mode ?? 'raw')
                            ? 'border-[#5797ff] bg-[#5797ff]'
                            : 'border-[var(--border)]'
                        }`}
                      />
                      {item}
                    </label>
                  ))}
                  <span className="font-semibold text-[#74a8ff]">JSON</span>
                </div>
              ) : null}

              <div ref={responseSplitRef} className="min-h-0 flex flex-1 flex-col bg-[var(--bg)]">
                <div className="min-h-0 flex-1 overflow-auto border-b border-[var(--border)] bg-[var(--bg)]">
                  {renderActiveTab()}
                </div>

                <div
                  className="flex h-5 cursor-row-resize items-center justify-center bg-[var(--surface)] hover:bg-[var(--panel)]"
                  onPointerDown={(event) => {
                    event.preventDefault()
                    setIsResizingResponse(true)
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                >
                  <div className="flex h-1.5 w-12 items-center justify-between">
                    <span className="block h-0.5 w-3 rounded-full bg-[var(--muted)]" />
                    <span className="text-xs text-[var(--muted)]">⇕</span>
                    <span className="block h-0.5 w-3 rounded-full bg-[var(--muted)]" />
                  </div>
                </div>

                <div className="min-h-0 overflow-auto px-4 py-3" style={{ height: `${responseHeight}px` }}>
                    {sendError ? (
                      <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">
                        {sendError}
                      </pre>
                    ) : sendResult ? (
                      <div className="space-y-3">
                        {sendResult.headers.length > 0 ? (
                          <div className="grid grid-cols-[220px_1fr] rounded border border-[var(--border)] text-xs">
                            {sendResult.headers.map((header) => (
                              <div key={`${header.key}-${header.value}`} className="contents">
                                <div className="border-b border-[var(--border)] px-3 py-1 font-mono text-[var(--text)]">
                                  {header.key}
                                </div>
                                <div className="border-b border-[var(--border)] px-3 py-1 font-mono text-[var(--muted)]">
                                  {header.value}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">
                          {formatMaybeJson(sendResult.body) || 'No response body.'}
                        </pre>
                      </div>
                    ) : responseExamples.length > 0 ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
                          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                            <span className="font-semibold text-[var(--text)]">Example</span>
                            <span className="text-[var(--muted)]">▼</span>
                          </div>
                          <select
                            value={selectedResponseIndex}
                            onChange={(event) => setSelectedResponseIndex(Number(event.target.value))}
                            className="select-field min-w-[180px] rounded px-3 py-2 text-sm outline-none focus:border-[#5a8fff]"
                          >
                            {responseExamples.map((response, index) => (
                              <option key={`${response.name ?? 'example'}-${index}`} value={index}>
                                {response.name ?? `Example ${index + 1}`} {response.status ? ` — ${response.status}` : ''}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--panel)] p-4">
                          <div className="flex flex-wrap items-center gap-3 text-sm">
                            <span className="font-semibold text-[var(--text)]">{selectedResponse?.name ?? 'Example'}</span>
                            <span className="text-[var(--muted)]">{selectedResponse?.status ?? 'Imported response'}</span>
                            {selectedResponse?.code ? (
                              <span className="rounded bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted)]">
                                {selectedResponse.code}
                              </span>
                            ) : null}
                          </div>
                          <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-3 font-mono text-xs leading-5 text-[var(--text)]">
                            {selectedResponseBody || 'No response body.'}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
                        Response body will appear here.
                      </div>
                    )}
                  </div>
                </div>
              </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <h2 className="text-lg font-semibold text-[var(--text)]">No request open</h2>
                <p className="mt-2 max-w-sm text-sm text-[var(--muted)]">
                  Import the sample Postman collection or create a collection to begin building the
                  request workspace.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default App
