import React from 'react'

type Props = {
  importInputRef: React.RefObject<HTMLInputElement>
  handleImportFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  handleCreateCollection: (e: React.FormEvent<HTMLFormElement>) => Promise<void>
  collectionName: string
  setCollectionName: (v: string) => void
  selectedWorkspace: any
  environments: any[]
  selectedEnvironmentId: string | null
  setSelectedEnvironmentId: (id: string | null) => void
  environmentName: string
  setEnvironmentName: (v: string) => void
  handleCreateEnvironment: (e: React.FormEvent<HTMLFormElement>) => Promise<void>
  environmentVariables: any[]
  variableKey: string
  setVariableKey: (v: string) => void
  variableValue: string
  setVariableValue: (v: string) => void
  handleSaveVariable: (e: React.FormEvent<HTMLFormElement>) => Promise<void>
  handleEditVariable: (variable: any) => void
  handleDeleteVariable: (variable: any) => Promise<void>
  isTauriRuntime: boolean
  error: string | null
  notice: string | null
  loadingCollections: boolean
  collections: any[]
  loadingRequests: boolean
  foldersByParent: Map<string, any[]>
  requestsByFolder: Map<string, any[]>
  selectedCollectionId: string | null
  setSelectedCollectionId: (id: string | null) => void
  renderFolder: (folder: any, depth?: number) => JSX.Element
  renderRequestRow: (request: any, depth?: number) => JSX.Element
  handleRenameCollection: (c: any) => Promise<void>
  handleDeleteCollection: (c: any) => Promise<void>
}

export default function Sidebar(props: Props) {
  const {
    importInputRef,
    handleImportFile,
    handleCreateCollection,
    collectionName,
    setCollectionName,
    selectedWorkspace,
    environments,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    environmentName,
    setEnvironmentName,
    handleCreateEnvironment,
    environmentVariables,
    variableKey,
    setVariableKey,
    variableValue,
    setVariableValue,
    handleSaveVariable,
    handleEditVariable,
    handleDeleteVariable,
    isTauriRuntime,
    error,
    notice,
    loadingCollections,
    collections,
    loadingRequests,
    foldersByParent,
    requestsByFolder,
    selectedCollectionId,
    setSelectedCollectionId,
    renderFolder,
    renderRequestRow,
    handleRenameCollection,
    handleDeleteCollection,
  } = props

  return (
    <aside className="flex w-[385px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-alt)]">
      <div className="border-b border-[var(--border)] p-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xs font-bold uppercase tracking-wide text-[var(--text)]">Collections</h1>
          <button className="toolbar-button" onClick={() => importInputRef.current?.click()} disabled={!selectedWorkspace} title="Import Postman collection">Import</button>
          <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
        </div>

        <form className="mt-3 flex gap-2" onSubmit={handleCreateCollection}>
          <input value={collectionName} onChange={(e) => setCollectionName(e.target.value)} placeholder="New collection" className="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]" disabled={!selectedWorkspace} />
          <button className="primary-button h-8" disabled={!collectionName.trim() || !selectedWorkspace}>+</button>
        </form>

        {selectedWorkspace ? <p className="mt-3 truncate text-xs text-[#8c8c8c]">Workspace: {selectedWorkspace.name}</p> : null}
        {!isTauriRuntime ? <p className="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">Browser preview mode: data is stored in localStorage. Run the desktop app for SQLite.</p> : null}
        {error ? <p className="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">{error}</p> : null}
        {notice ? <p className="mt-3 rounded bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">{notice}</p> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {loadingCollections ? (
          <p className="px-2 py-3 text-sm text-[var(--muted)]">Loading collections...</p>
        ) : collections.length === 0 ? (
          <div className="px-2 py-4 text-sm text-[#9a9a9a]">Create a collection or import the Postman JSON sample.</div>
        ) : (
          collections.map((collection) => {
            const expanded = collection.id === selectedCollectionId
            const rootFolders = foldersByParent.get('__root__') ?? []
            const rootRequests = requestsByFolder.get('__root__') ?? []

            return (
              <div key={collection.id} className="mb-1">
                <div className={`group flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm ${expanded ? 'bg-[var(--surface)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--panel)]'}`}>
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelectedCollectionId(collection.id)}>
                    <span className="w-3 shrink-0 text-[var(--muted)]">{expanded ? 'v' : '>'}</span>
                    <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                  </button>
                  <button className="rounded px-1 text-[11px] text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] group-hover:opacity-100" onClick={() => handleRenameCollection(collection)}>Rename</button>
                  <button className="rounded px-1 text-[11px] text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] group-hover:opacity-100" onClick={() => handleDeleteCollection(collection)}>Delete</button>
                </div>

                {expanded ? (
                  <div className="ml-3 mt-1 space-y-1">
                    {loadingRequests ? (
                      <p className="py-2 text-xs text-[var(--muted)]">Loading requests...</p>
                    ) : rootFolders.length === 0 && rootRequests.length === 0 ? (
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

      <div className="border-t border-[var(--border)]">
        <div className="border-b border-[var(--border)] px-3 py-3">
          <div className="flex items-center justify-between gap-2 text-xs font-bold uppercase text-[var(--text)]">
            <span>Environments</span>
            <span className="text-[10px] font-medium text-[var(--muted)]">
              {environmentVariables.length} vars
            </span>
          </div>

          <select
            value={selectedEnvironmentId ?? ''}
            onChange={(event) => setSelectedEnvironmentId(event.target.value || null)}
            className="select-field mt-3 h-8 w-full rounded px-2 text-sm outline-none"
            disabled={!selectedWorkspace || environments.length === 0}
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>

          <form className="mt-2 flex gap-2" onSubmit={handleCreateEnvironment}>
            <input
              value={environmentName}
              onChange={(event) => setEnvironmentName(event.target.value)}
              placeholder="New environment"
              className="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
              disabled={!selectedWorkspace}
            />
            <button className="secondary-button h-8" disabled={!environmentName.trim() || !selectedWorkspace}>
              Add
            </button>
          </form>

          <form className="mt-3 space-y-2" onSubmit={handleSaveVariable}>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={variableKey}
                onChange={(event) => setVariableKey(event.target.value)}
                placeholder="key"
                className="h-8 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-xs text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
                disabled={!selectedEnvironmentId}
              />
              <input
                value={variableValue}
                onChange={(event) => setVariableValue(event.target.value)}
                placeholder="value"
                className="h-8 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-xs text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
                disabled={!selectedEnvironmentId}
              />
            </div>
            <button className="secondary-button h-8 w-full" disabled={!selectedEnvironmentId || !variableKey.trim()}>
              Save Variable
            </button>
          </form>

          <div className="mt-3 max-h-40 space-y-1 overflow-auto">
            {environmentVariables.length === 0 ? (
              <p className="text-xs font-normal normal-case text-[var(--muted)]">
                Add `thub_url` to resolve {'{{thub_url}}'}.
              </p>
            ) : (
              environmentVariables.map((variable) => (
                <div
                  key={variable.id}
                  className="group flex items-center gap-2 rounded bg-[var(--panel)] px-2 py-1 text-xs"
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => handleEditVariable(variable)}
                    type="button"
                    title="Edit variable"
                  >
                    <span className="font-mono text-[var(--text)]">{`{{${variable.key}}}`}</span>
                    <span className="ml-2 font-normal text-[var(--muted)]">{variable.value}</span>
                  </button>
                  <button
                    type="button"
                    className="text-[var(--muted)] opacity-0 group-hover:opacity-100"
                    onClick={() => handleDeleteVariable(variable)}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {['Specs', 'Flows'].map((label) => (
          <button key={label} className="flex h-8 w-full items-center gap-2 border-b border-[var(--border)] px-3 text-left text-xs font-bold uppercase text-[var(--muted)]">
            <span>&gt;</span>
            {label}
          </button>
        ))}
      </div>
    </aside>
  )
}
