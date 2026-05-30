import { invoke } from '@tauri-apps/api/core'

export type Workspace = {
  id: string
  name: string
}

export async function getWorkspaces(): Promise<Workspace[]> {
  return invoke('list_workspaces')
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return invoke('create_workspace', { name })
}
