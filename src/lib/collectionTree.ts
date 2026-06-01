import type { ApiFolder, ApiRequest } from '../tauri'

export const ROOT_ID = '__root__'

const METHOD_STYLES: Record<string, string> = {
  GET: 'text-emerald-400',
  POST: 'text-amber-300',
  PUT: 'text-sky-300',
  PATCH: 'text-violet-300',
  DELETE: 'text-rose-300',
  HEAD: 'text-stone-300',
  OPTIONS: 'text-cyan-300',
}

export function methodClass(method: string): string {
  return METHOD_STYLES[method.toUpperCase()] ?? 'text-slate-300'
}

export function sortByCreated<T extends { created_at: number; id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.created_at !== right.created_at) return left.created_at - right.created_at
    return left.id.localeCompare(right.id)
  })
}

export function groupFoldersByParent(folders: ApiFolder[]): Map<string, ApiFolder[]> {
  const groups = new Map<string, ApiFolder[]>()

  for (const folder of sortByCreated(folders)) {
    const parentId = folder.parent_folder_id ?? ROOT_ID
    groups.set(parentId, [...(groups.get(parentId) ?? []), folder])
  }

  return groups
}

export function groupRequestsByFolder(requests: ApiRequest[]): Map<string, ApiRequest[]> {
  const groups = new Map<string, ApiRequest[]>()

  for (const request of sortByCreated(requests)) {
    const folderId = request.folder_id ?? ROOT_ID
    groups.set(folderId, [...(groups.get(folderId) ?? []), request])
  }

  return groups
}
