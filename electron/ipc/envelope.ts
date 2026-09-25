import type { IpcErrorPayload } from '../../shared/types'

/**
 * What crosses the IPC boundary. ipcMain.handle rejections lose everything except the message
 * text, so handlers always resolve with an envelope and preload rethrows a real IpcError.
 */
export type IpcEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: IpcErrorPayload }
