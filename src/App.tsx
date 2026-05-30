import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiRequest,
  Collection,
  Workspace,
  createCollection,
  createWorkspace,
  deleteCollection,
  getCollections,
  getRequests,
  getWorkspaces,
  importPostmanCollection,
  isTauriRuntime,
  renameCollection,
} from './tauri'

type HeaderDocument = {
  key?: string
  value?: string
}

type ResponseExample = {
  name?: string
  status?: string
  code?: number
  body?: string
}

type RequestDocument = {
  description?: string | null
  headers?: HeaderDocument[]
  body?: {
    mode?: string
    raw?: string
  } | null
  responses?: ResponseExample[]
}

const REQUEST_TABS = ['Docs', 'Params', 'Authorization', 'Headers', 'Body', 'Scripts', 'Settings']

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

function editorLines(value: string): string[] {
  return value ? value.split('\n') : ['']
}

function App() {
  const importInputRef = useRef<HTMLInputElement>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [requests, setRequests] = useState<ApiRequest[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState('')
  const [collectionName, setCollectionName] = useState('')
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true)
  const [loadingCollections, setLoadingCollections] = useState(false)
  const [loadingRequests, setLoadingRequests] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
  const requestBody = useMemo(
    () => formatMaybeJson(selectedDocument.body?.raw ?? ''),
    [selectedDocument.body?.raw],
  )
  const responseExamples = Array.isArray(selectedDocument.responses) ? selectedDocument.responses : []
  const firstResponse = responseExamples[0] ?? null
  const firstResponseBody = firstResponse?.body ? formatMaybeJson(firstResponse.body) : ''
  const headers = Array.isArray(selectedDocument.headers) ? selectedDocument.headers : []
  const description =
    typeof selectedDocument.description === 'string' ? selectedDocument.description.trim() : ''

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
      setRequests([])
      setSelectedRequestId(null)
      return
    }

    const collectionId = selectedCollectionId
    let ignore = false

    async function loadRequests() {
      setLoadingRequests(true)

      try {
        const items = await getRequests(collectionId)
        if (ignore) return

        setRequests(items)
        setSelectedRequestId((current) => {
          if (current && items.some((request) => request.id === current)) return current
          return items[0]?.id ?? null
        })
        setError(null)
      } catch (err) {
        console.error(err)
        if (!ignore) setError('Unable to load requests for this collection.')
      } finally {
        if (!ignore) setLoadingRequests(false)
      }
    }

    loadRequests()

    return () => {
      ignore = true
    }
  }, [selectedCollectionId])

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
      setRequests(result.requests)
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

  return (
    <main className="h-screen overflow-hidden bg-[#1f1f1f] text-[#f1f1f1]">
      <header className="flex h-7 items-center border-b border-[#202020] bg-[#282b2f] px-3 text-[13px]">
        <div className="flex w-1/3 items-center gap-4 font-medium text-white">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Help</span>
        </div>
        <div className="w-1/3 truncate text-center text-[#ededed]">
          {selectedRequest ? `${selectedRequest.name} - Slinger` : 'Slinger'}
        </div>
        <div className="flex w-1/3 justify-end gap-3 text-[#a7a7a7]">
          <span>Invite</span>
          <span>Upgrade</span>
        </div>
      </header>

      <div className="flex h-16 items-center gap-3 border-b border-[#303030] bg-[#242424] px-3">
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
          className="h-8 w-52 rounded border border-[#393939] bg-[#1f1f1f] px-2 text-sm text-white outline-none"
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
            className="h-8 w-40 rounded border border-[#393939] bg-[#1f1f1f] px-2 text-sm outline-none placeholder:text-[#777]"
          />
          <button className="secondary-button" disabled={!workspaceName.trim()}>
            Add
          </button>
        </form>

        <div className="mx-auto flex h-8 w-[320px] items-center rounded border border-[#3a3a3a] bg-[#202020] px-3 text-sm text-[#9d9d9d]">
          Search
        </div>

        <button className="secondary-button">Save</button>
        <button className="secondary-button">Share</button>
      </div>

      <div className="flex h-[calc(100vh-92px)] min-h-0">
        <aside className="flex w-[385px] shrink-0 flex-col border-r border-[#333] bg-[#242424]">
          <div className="border-b border-[#343434] p-3">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xs font-bold uppercase tracking-wide text-white">Collections</h1>
              <div className="flex items-center gap-2">
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
            </div>

            <form className="mt-3 flex gap-2" onSubmit={handleCreateCollection}>
              <input
                value={collectionName}
                onChange={(event) => setCollectionName(event.target.value)}
                placeholder="New collection"
                className="h-8 min-w-0 flex-1 rounded border border-[#383838] bg-[#1f1f1f] px-2 text-sm outline-none placeholder:text-[#737373]"
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
              <p className="mt-3 rounded bg-[#322817] px-3 py-2 text-xs text-[#f1d08a]">
                Browser preview mode: data is stored in localStorage. Run the desktop app for SQLite.
              </p>
            ) : null}
            {error ? <p className="mt-3 rounded bg-[#3a1717] px-3 py-2 text-xs text-[#ffb3b3]">{error}</p> : null}
            {notice ? (
              <p className="mt-3 rounded bg-[#17321f] px-3 py-2 text-xs text-[#b7e3c4]">{notice}</p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            {loadingCollections ? (
              <p className="px-2 py-3 text-sm text-[#999]">Loading collections...</p>
            ) : collections.length === 0 ? (
              <div className="px-2 py-4 text-sm text-[#9a9a9a]">
                Create a collection or import the Postman JSON sample.
              </div>
            ) : (
              collections.map((collection) => {
                const expanded = collection.id === selectedCollectionId

                return (
                  <div key={collection.id} className="mb-1">
                    <div
                      className={`group flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${
                        expanded ? 'bg-[#353535] text-white' : 'text-[#d8d8d8] hover:bg-[#303030]'
                      }`}
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setSelectedCollectionId(collection.id)}
                      >
                        <span className="w-3 shrink-0 text-[#bdbdbd]">{expanded ? 'v' : '>'}</span>
                        <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                      </button>
                      <button
                        className="rounded px-1 text-[11px] text-[#9d9d9d] opacity-0 hover:bg-[#444] group-hover:opacity-100"
                        onClick={() => handleRenameCollection(collection)}
                      >
                        Rename
                      </button>
                      <button
                        className="rounded px-1 text-[11px] text-[#c18f8f] opacity-0 hover:bg-[#442929] group-hover:opacity-100"
                        onClick={() => handleDeleteCollection(collection)}
                      >
                        Delete
                      </button>
                    </div>

                    {expanded ? (
                      <div className="ml-6 mt-1 space-y-1">
                        {loadingRequests ? (
                          <p className="py-2 text-xs text-[#999]">Loading requests...</p>
                        ) : requests.length === 0 ? (
                          <p className="py-2 text-xs text-[#999]">No requests yet.</p>
                        ) : (
                          requests.map((request) => (
                            <button
                              key={request.id}
                              onClick={() => setSelectedRequestId(request.id)}
                              className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs ${
                                request.id === selectedRequestId
                                  ? 'bg-[#3d3d3d] text-white'
                                  : 'text-[#d7d7d7] hover:bg-[#303030]'
                              }`}
                            >
                              <span className={`w-12 shrink-0 font-semibold ${methodClass(request.method)}`}>
                                {request.method}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{request.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>

          <div className="border-t border-[#343434] text-xs font-bold uppercase text-white">
            {['Environments', 'Specs', 'Flows'].map((label) => (
              <button
                key={label}
                className="flex h-8 w-full items-center gap-2 border-b border-[#303030] px-3 text-left"
              >
                <span>&gt;</span>
                {label}
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[#1f1f1f]">
          <div className="flex h-9 items-end gap-1 border-b border-[#343434] bg-[#252525] px-4">
            {selectedRequest ? (
              <button className="h-7 max-w-[260px] truncate rounded-t bg-[#3a3a3a] px-4 text-left text-xs text-white">
                <span className={`mr-2 font-semibold ${methodClass(selectedRequest.method)}`}>
                  {selectedRequest.method}
                </span>
                {selectedRequest.name}
              </button>
            ) : (
              <button className="h-7 rounded-t bg-[#303030] px-4 text-xs text-[#aaa]">No request selected</button>
            )}
            <button className="h-7 px-3 text-lg text-[#999]">+</button>
          </div>

          {selectedRequest ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-10 items-center gap-2 border-b border-[#303030] px-4 text-sm">
                <span className="text-[#8d8d8d]">{selectedCollection?.name}</span>
                <span className="text-[#606060]">&gt;</span>
                <span className="font-semibold text-white">{selectedRequest.name}</span>
              </div>

              <div className="flex items-center gap-2 border-b border-[#353535] px-3 py-3">
                <div
                  className={`flex h-8 w-24 items-center justify-center rounded border border-[#424242] bg-[#2a2a2a] text-sm font-bold ${methodClass(
                    selectedRequest.method,
                  )}`}
                >
                  {selectedRequest.method}
                </div>
                <div className="flex h-8 min-w-0 flex-1 items-center rounded border border-[#424242] bg-[#1e1e1e] px-3 font-mono text-sm">
                  <span className="truncate">{selectedRequest.url || 'No URL saved'}</span>
                </div>
                <button className="primary-button h-8 w-24">Send</button>
              </div>

              <div className="flex h-10 items-center gap-6 border-b border-[#303030] px-4 text-sm text-[#b8b8b8]">
                {REQUEST_TABS.map((tab) => (
                  <button
                    key={tab}
                    className={`h-10 border-b-2 ${
                      tab === 'Body'
                        ? 'border-[#f26b3a] font-semibold text-white'
                        : 'border-transparent hover:text-white'
                    }`}
                  >
                    {tab}
                    {tab === 'Headers' && headers.length > 0 ? (
                      <span className="ml-1 text-[#777]">{headers.length}</span>
                    ) : null}
                  </button>
                ))}
              </div>

              <div className="flex h-10 items-center gap-4 border-b border-[#303030] px-4 text-sm text-[#d0d0d0]">
                {['none', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary', 'GraphQL'].map((item) => (
                  <label key={item} className="flex items-center gap-2">
                    <span
                      className={`h-3 w-3 rounded-full border ${
                        item === 'raw' ? 'border-[#5797ff] bg-[#5797ff]' : 'border-[#777]'
                      }`}
                    />
                    {item}
                  </label>
                ))}
                <span className="font-semibold text-[#74a8ff]">JSON</span>
              </div>

              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_260px]">
                <div className="min-h-0 overflow-auto border-b border-[#343434] bg-[#1f1f1f] font-mono text-[13px] leading-5 text-[#c7d3e5]">
                  {editorLines(requestBody || description || 'No body saved for this request.').map(
                    (line, index) => (
                      <div key={`${index}-${line}`} className="grid grid-cols-[64px_1fr]">
                        <span className="select-none border-r border-[#343434] pr-4 text-right text-[#8a8a8a]">
                          {index + 1}
                        </span>
                        <span className="whitespace-pre px-4">{line || ' '}</span>
                      </div>
                    ),
                  )}
                </div>

                <div className="flex min-h-0 flex-col bg-[#1f1f1f]">
                  <div className="flex h-10 items-center gap-5 border-b border-[#303030] px-4 text-sm">
                    <span className="font-semibold text-white">Response</span>
                    <span className="text-[#858585]">History</span>
                    {responseExamples.length > 0 ? (
                      <span className="ml-auto text-xs text-[#9d9d9d]">
                        {responseExamples.length} imported examples
                      </span>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                    {firstResponse ? (
                      <div className="space-y-3">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="font-semibold text-white">{firstResponse.name ?? 'Example'}</span>
                          <span className="text-[#9d9d9d]">{firstResponse.status ?? 'Imported response'}</span>
                          {firstResponse.code ? (
                            <span className="rounded bg-[#1e3a2a] px-2 py-0.5 text-xs text-[#8de1a6]">
                              {firstResponse.code}
                            </span>
                          ) : null}
                        </div>
                        <pre className="overflow-auto whitespace-pre-wrap rounded border border-[#333] bg-[#202020] p-3 font-mono text-xs leading-5 text-[#cbd5e1]">
                          {firstResponseBody || 'No response body.'}
                        </pre>
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-[#8e8e8e]">
                        Send the request to capture a response.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <h2 className="text-lg font-semibold text-white">No request open</h2>
                <p className="mt-2 max-w-sm text-sm text-[#a5a5a5]">
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
