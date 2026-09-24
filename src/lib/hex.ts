/** Small helpers for showing and saving binary response bodies. */

export function hexDump(bytes: Uint8Array, limit = 4096): string {
  const lines: string[] = []
  const n = Math.min(bytes.length, limit)
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n))
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`)
  }
  if (bytes.length > limit) lines.push(`… ${bytes.length - limit} more bytes not shown`)
  return lines.join('\n')
}

const EXT: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/css': 'css',
  'application/javascript': 'js',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/zip': 'zip',
}

/** Picks a download file name: Content-Disposition filename, else `response.<ext from mime>`. */
export function suggestFileName(mime: string, contentDisposition?: string | null): string {
  const m = contentDisposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition) : null
  if (m) {
    try {
      const name = decodeURIComponent(m[1]).replace(/[\\/:*?"<>|]/g, '_').trim()
      if (name) return name
    } catch {
      /* fall through */
    }
  }
  const base = mime.split(';')[0].trim().toLowerCase()
  const ext = EXT[base] ?? (base.endsWith('+json') ? 'json' : base.endsWith('+xml') ? 'xml' : 'bin')
  return `response.${ext}`
}
