import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, MENU_COMMAND_CHANNEL, SYNC_EVENT_CHANNEL, type SlingerIpcApi } from '../shared/ipc-contract'
import { parseMenuCommand, type MenuCommand } from '../shared/menu'
import type { SyncEvent } from '../shared/types'
import type { IpcEnvelope } from './ipc/envelope'

// Exposes `window.slinger` exactly as declared by SlingerIpcApi. No Node/Electron objects leak:
// each method only forwards its arguments over `ipcRenderer.invoke` on a fixed channel.
const api = {} as Record<string, unknown>
for (const channel of IPC_CHANNELS) {
  api[channel] = async (...args: unknown[]) => {
    const envelope = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope
    if (envelope.ok) return envelope.value
    // Error subclasses lose `code`/`details` when crossing contextBridge (only name/message
    // survive), so reject with a plain IpcErrorPayload-shaped object. See shared/ipc-errors.ts.
    throw { name: 'IpcError', ...envelope.error }
  }
}

// Push channel (main -> renderer). Only a listener is exposed, never the raw ipcRenderer event.
api.onSyncEvent = (listener: (event: SyncEvent) => void): (() => void) => {
  const handler = (_event: unknown, payload: unknown) => listener(payload as SyncEvent)
  ipcRenderer.on(SYNC_EVENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(SYNC_EVENT_CHANNEL, handler)
  }
}

// Application-menu commands (main -> renderer). Anything that is not a known command name is dropped here.
api.onMenuCommand = (listener: (command: MenuCommand) => void): (() => void) => {
  const handler = (_event: unknown, payload: unknown) => {
    const command = parseMenuCommand(payload)
    if (command) listener(command)
  }
  ipcRenderer.on(MENU_COMMAND_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(MENU_COMMAND_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('slinger', api as unknown as SlingerIpcApi)
