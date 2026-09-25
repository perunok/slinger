import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS, type SlingerIpcApi } from '../shared/ipc-contract'
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
  ipcRenderer.on(IPC_EVENT_CHANNELS[0], handler)
  return () => {
    ipcRenderer.removeListener(IPC_EVENT_CHANNELS[0], handler)
  }
}

contextBridge.exposeInMainWorld('slinger', api as unknown as SlingerIpcApi)
