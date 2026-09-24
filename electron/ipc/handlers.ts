import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type SlingerIpcApi } from '../../shared/ipc-contract'
import { toErrorPayload } from '../lib/errors'
import type { IpcEnvelope } from './envelope'

/**
 * Registers one `ipcMain.handle` per channel in IPC_CHANNELS. The channel name equals the API
 * method name. Every call is refused unless it comes from the app's own renderer frame.
 */
export function registerIpcHandlers(api: SlingerIpcApi, isTrustedFrameUrl: (url: string) => boolean): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcEnvelope> => {
      const frameUrl = event.senderFrame?.url ?? ''
      if (!isTrustedFrameUrl(frameUrl)) {
        return { ok: false, error: { code: 'invalid_input', message: 'IPC call from an untrusted origin was rejected' } }
      }
      try {
        const method = api[channel] as (...a: unknown[]) => Promise<unknown>
        return { ok: true, value: await method(...args) }
      } catch (err) {
        if (toErrorPayload(err).code === 'internal_error') console.error(`[slinger] ${channel} failed:`, err)
        return { ok: false, error: toErrorPayload(err) }
      }
    })
  }
}
