import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, MCP_CALL_CHANNEL, MCP_CLIENT_EVENT_CHANNEL, MENU_COMMAND_CHANNEL, SYNC_EVENT_CHANNEL, WINDOW_STATE_CHANNEL, type SlingerIpcApi } from '../shared/ipc-contract'
import type { McpCall } from '../shared/mcp'
import { parseMenuCommand, type MenuCommand } from '../shared/menu'
import type { McpClientEvent, SyncEvent, WindowState } from '../shared/types'
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

// Main window state (custom title bar buttons). Only the three booleans pass.
api.onWindowState = (listener: (state: WindowState) => void): (() => void) => {
  const handler = (_event: unknown, payload: unknown) => {
    const p = (payload ?? {}) as Partial<Record<keyof WindowState, unknown>>
    listener({ maximized: p.maximized === true, fullScreen: p.fullScreen === true, focused: p.focused === true })
  }
  ipcRenderer.on(WINDOW_STATE_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, handler)
  }
}

// MCP tool calls (main -> renderer). Only the three fields pass; the renderer validates the arguments itself.
api.onMcpCall = (listener: (call: McpCall) => void): (() => void) => {
  const handler = (_event: unknown, payload: unknown) => {
    const p = (payload ?? {}) as Partial<Record<keyof McpCall, unknown>>
    if (typeof p.id === 'string' && typeof p.tool === 'string') listener({ id: p.id, tool: p.tool as McpCall['tool'], args: p.args })
  }
  ipcRenderer.on(MCP_CALL_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(MCP_CALL_CHANNEL, handler)
  }
}

// MCP client sessions (main -> renderer): message log, notifications, stderr. Only well-formed events pass.
const MCP_CLIENT_EVENT_TYPES = new Set<unknown>(['send', 'receive', 'notification', 'stderr', 'closed', 'error'])
api.onMcpClientEvent = (listener: (event: McpClientEvent) => void): (() => void) => {
  const handler = (_event: unknown, payload: unknown) => {
    const p = (payload ?? {}) as Partial<Record<keyof McpClientEvent, unknown>>
    if (typeof p.sessionId !== 'string' || typeof p.at !== 'number' || !MCP_CLIENT_EVENT_TYPES.has(p.type)) return
    listener({ sessionId: p.sessionId, at: p.at, type: p.type as McpClientEvent['type'], payload: p.payload })
  }
  ipcRenderer.on(MCP_CLIENT_EVENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(MCP_CLIENT_EVENT_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('slinger', api as unknown as SlingerIpcApi)
