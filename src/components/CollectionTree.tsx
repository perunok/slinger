import { methodClass, ROOT_ID } from '../lib/collectionTree'
import type { ApiFolder, ApiRequest, Collection } from '../tauri'

type CollectionTreeProps = {
  collections: Collection[]
  foldersByParent: Map<string, ApiFolder[]>
  handleDeleteCollection: (collection: Collection) => Promise<void>
  handleRenameCollection: (collection: Collection) => Promise<void>
  loadingRequests: boolean
  openFolderIds: Set<string>
  requestsByFolder: Map<string, ApiRequest[]>
  selectedCollectionId: string | null
  selectedRequestId: string | null
  setSelectedCollectionId: (id: string | null) => void
  setSelectedRequestId: (id: string | null) => void
  toggleFolder: (folderId: string) => void
}

export default function CollectionTree({
  collections,
  foldersByParent,
  handleDeleteCollection,
  handleRenameCollection,
  loadingRequests,
  openFolderIds,
  requestsByFolder,
  selectedCollectionId,
  selectedRequestId,
  setSelectedCollectionId,
  setSelectedRequestId,
  toggleFolder,
}: CollectionTreeProps) {
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

  return (
    <>
      {collections.map((collection) => {
        const expanded = collection.id === selectedCollectionId
        const rootFolders = foldersByParent.get(ROOT_ID) ?? []
        const rootRequests = requestsByFolder.get(ROOT_ID) ?? []

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
      })}
    </>
  )
}
