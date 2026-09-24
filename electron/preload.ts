import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SlingerIpcApi } from '../shared/ipc-contract'
import type { IpcEnvelope } from './ipc/envelope'

// Exposes `window.slinger` exactly as declared by SlingerIpcApi. No Node/Electron objects leak:
// each method only forwards its arguments over `ipcRenderer.invoke` on a fixed channel.
const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const channel of IPC_CHANNELS) {
  api[channel] = async (...args: unknown[]) => {
    const envelope = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope
    if (envelope.ok) return envelope.value
    // Error subclasses lose `code`/`details` when crossing contextBridge (only name/message
    // survive), so reject with a plain IpcErrorPayload-shaped object. See shared/ipc-errors.ts.
    throw { name: 'IpcError', ...envelope.error }
  }
}

contextBridge.exposeInMainWorld('slinger', api as unknown as SlingerIpcApi)
