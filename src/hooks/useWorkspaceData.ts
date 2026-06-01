import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react'
import {
  groupFoldersByParent,
  groupRequestsByFolder,
} from '../lib/collectionTree'
import {
  type Collection,
  type EnvironmentVariable,
  createCollection,
  createEnvironment,
  createWorkspace,
  deleteCollection,
  deleteEnvironmentVariable,
  ensureDefaultEnvironment,
  getCollections,
  getEnvironmentVariables,
  getEnvironments,
  getFolders,
  getRequests,
  getWorkspaces,
  importPostmanCollection,
  renameCollection,
  upsertEnvironmentVariable,
} from '../tauri'

export function useWorkspaceData() {
  const [workspaces, setWorkspaces] = useState<import('../tauri').Workspace[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [folders, setFolders] = useState<import('../tauri').ApiFolder[]>([])
  const [requests, setRequests] = useState<import('../tauri').ApiRequest[]>([])
  const [environments, setEnvironments] = useState<import('../tauri').Environment[]>([])
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariable[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null)
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(new Set())
  const [workspaceName, setWorkspaceName] = useState('')
  const [collectionName, setCollectionName] = useState('')
  const [environmentName, setEnvironmentName] = useState('')
  const [variableKey, setVariableKey] = useState('')
  const [variableValue, setVariableValue] = useState('')
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
  const foldersByParent = useMemo(() => groupFoldersByParent(folders), [folders])
  const requestsByFolder = useMemo(() => groupRequestsByFolder(requests), [requests])

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
      setEnvironments([])
      setEnvironmentVariables([])
      setSelectedCollectionId(null)
      setSelectedEnvironmentId(null)
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
    if (!selectedWorkspaceId) return

    const workspaceId = selectedWorkspaceId
    let ignore = false

    async function loadEnvironments() {
      try {
        const defaultEnvironment = await ensureDefaultEnvironment(workspaceId)
        const items = await getEnvironments(workspaceId)
        if (ignore) return

        const nextItems =
          items.length > 0 && items.some((environment) => environment.id === defaultEnvironment.id)
            ? items
            : [defaultEnvironment, ...items]
        setEnvironments(nextItems)
        setSelectedEnvironmentId((current) => {
          if (current && nextItems.some((environment) => environment.id === current)) return current
          return defaultEnvironment.id
        })
        setError(null)
      } catch (err) {
        console.error(err)
        if (!ignore) setError('Unable to load environments for this workspace.')
      }
    }

    loadEnvironments()

    return () => {
      ignore = true
    }
  }, [selectedWorkspaceId])

  useEffect(() => {
    if (!selectedEnvironmentId) {
      setEnvironmentVariables([])
      return
    }

    const environmentId = selectedEnvironmentId
    let ignore = false

    async function loadVariables() {
      try {
        const items = await getEnvironmentVariables(environmentId)
        if (!ignore) setEnvironmentVariables(items)
      } catch (err) {
        console.error(err)
        if (!ignore) setError('Unable to load environment variables.')
      }
    }

    loadVariables()

    return () => {
      ignore = true
    }
  }, [selectedEnvironmentId])

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

  async function handleCreateEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = environmentName.trim()
    if (!name || !selectedWorkspaceId) return

    try {
      const environment = await createEnvironment(selectedWorkspaceId, name)
      setEnvironments((current) => [...current, environment])
      setSelectedEnvironmentId(environment.id)
      setEnvironmentName('')
      setNotice(`Environment "${environment.name}" created.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to create environment.')
    }
  }

  async function handleSaveVariable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedEnvironmentId || !variableKey.trim()) return

    try {
      const variable = await upsertEnvironmentVariable(
        selectedEnvironmentId,
        variableKey,
        variableValue,
      )
      setEnvironmentVariables((current) => {
        const exists = current.some((item) => item.id === variable.id)
        if (exists) return current.map((item) => (item.id === variable.id ? variable : item))
        return [...current, variable]
      })
      setVariableKey('')
      setVariableValue('')
      setNotice(`Saved {{${variable.key}}}.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to save environment variable.')
    }
  }

  async function handleDeleteVariable(variable: EnvironmentVariable) {
    try {
      await deleteEnvironmentVariable(variable.id)
      setEnvironmentVariables((current) => current.filter((item) => item.id !== variable.id))
      setNotice(`Deleted {{${variable.key}}}.`)
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to delete environment variable.')
    }
  }

  function handleEditVariable(variable: EnvironmentVariable) {
    setVariableKey(variable.key)
    setVariableValue(variable.value)
  }

  function toggleFolder(folderId: string) {
    setOpenFolderIds((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  return {
    collectionName,
    collections,
    environmentName,
    environmentVariables,
    environments,
    error,
    foldersByParent,
    handleCreateCollection,
    handleCreateEnvironment,
    handleCreateWorkspace,
    handleDeleteCollection,
    handleDeleteVariable,
    handleEditVariable,
    handleImportFile,
    handleRenameCollection,
    handleSaveVariable,
    loadingCollections,
    loadingRequests,
    loadingWorkspaces,
    notice,
    openFolderIds,
    requestsByFolder,
    selectedCollection,
    selectedCollectionId,
    selectedEnvironmentId,
    selectedRequest,
    selectedRequestId,
    selectedWorkspace,
    selectedWorkspaceId,
    setCollectionName,
    setEnvironmentName,
    setError,
    setSelectedCollectionId,
    setSelectedEnvironmentId,
    setSelectedRequestId,
    setSelectedWorkspaceId,
    setVariableKey,
    setVariableValue,
    setWorkspaceName,
    toggleFolder,
    variableKey,
    variableValue,
    workspaceName,
    workspaces,
  }
}
