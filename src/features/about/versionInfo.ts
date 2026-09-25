import type { VersionInfo } from '../../../shared/types'

const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** The text "Copy version info" puts on the clipboard (for bug reports). */
export function formatVersionInfo(info: VersionInfo): string {
  const os = `${OS_NAMES[info.os.platform] ?? info.os.platform} ${info.os.release} (${info.os.arch})`
  return [
    `Slinger: ${info.app}`,
    `Electron: ${info.electron ?? 'n/a'}`,
    `Chromium: ${info.chrome ?? 'n/a'}`,
    `Node: ${info.node ?? 'n/a'}`,
    `V8: ${info.v8 ?? 'n/a'}`,
    `OS: ${os}`,
  ].join('\n')
}
