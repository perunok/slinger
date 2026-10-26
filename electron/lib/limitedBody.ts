/**
 * Reading response bodies without trusting their size: every network body Slinger keeps in memory goes through
 * readLimitedBody, which stops the download (cancels the stream) as soon as the limit is passed instead of reading it all
 * first. A declared Content-Length over the limit stops it before the first byte. streamBodyToFile writes a body to disk
 * chunk by chunk ("Send and download to file").
 */
import { createWriteStream, rmSync } from 'node:fs'

export type LimitedBody = { ok: true; bytes: Buffer } | { ok: false; received: number; declared: number | null }

/** The body, or how far it got before passing `max` bytes (the rest is never downloaded). */
export async function readLimitedBody(response: Response, max: number): Promise<LimitedBody> {
  const header = response.headers.get('content-length')
  const declared = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null
  if (declared !== null && declared > max) {
    await response.body?.cancel().catch(() => {})
    return { ok: false, received: 0, declared }
  }
  const reader = response.body?.getReader()
  if (!reader) return { ok: true, bytes: Buffer.alloc(0) }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return { ok: false, received: total, declared }
    }
    chunks.push(value)
  }
  return { ok: true, bytes: Buffer.concat(chunks, total) }
}

/** A failure of the file (not of the network) while streamBodyToFile wrote it. */
export class FileWriteError extends Error {}

/**
 * Writes the body to `path` (replacing it) and returns the number of bytes; a failed download leaves no partial file.
 * File failures reject with FileWriteError, network failures with the stream's own error.
 */
export async function streamBodyToFile(response: Response, path: string): Promise<number> {
  const out = createWriteStream(path, { flags: 'w', mode: 0o600 })
  let fileError: Error | null = null
  const failed = new Promise<never>((_, reject) => {
    out.on('error', (err) => {
      fileError = new FileWriteError(err.message)
      reject(fileError)
    })
  })
  failed.catch(() => {})
  let written = 0
  try {
    await Promise.race([new Promise<void>((resolve) => out.once('open', () => resolve())), failed])
    const reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        written += value.byteLength
        if (fileError) throw fileError
        if (!out.write(value)) await Promise.race([new Promise<void>((resolve) => out.once('drain', () => resolve())), failed])
      }
    }
    await Promise.race([new Promise<void>((resolve) => out.end(() => resolve())), failed])
    if (fileError) throw fileError
    return written
  } catch (err) {
    await response.body?.cancel().catch(() => {})
    out.destroy()
    rmSync(path, { force: true })
    throw fileError ?? err
  }
}
