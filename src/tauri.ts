import { invoke } from '@tauri-apps/api/tauri'

export type Workspace = {
  id: string
  name: string
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return invoke('create_workspace', { name })
}
