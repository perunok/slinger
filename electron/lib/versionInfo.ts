import { arch, platform, release } from 'node:os'
import type { VersionInfo } from '../../shared/types'

/** Version strings are short tokens like "33.4.11" or "130.0.6723.191"; anything else is dropped. */
const VERSION = /^[\w.+-]{1,64}$/
const clean = (v: unknown): string | null => (typeof v === 'string' && VERSION.test(v) ? v : null)

/**
 * The About dialog's "Copy version info" payload. An explicit allowlist: the app version, the runtime versions
 * (Electron, Chromium, Node, V8) and the OS family / kernel release / CPU arch. Never the host name, user name,
 * paths, environment variables or anything else from `process`.
 */
export function collectVersionInfo(
  appVersion: string,
  versions: Partial<Record<string, string | undefined>> = process.versions,
  os: { platform: string; release: string; arch: string } = { platform: platform(), release: release(), arch: arch() },
): VersionInfo {
  return {
    app: clean(appVersion) ?? 'unknown',
    electron: clean(versions.electron),
    chrome: clean(versions.chrome),
    node: clean(versions.node),
    v8: clean(versions.v8),
    os: { platform: clean(os.platform) ?? 'unknown', release: clean(os.release) ?? 'unknown', arch: clean(os.arch) ?? 'unknown' },
  }
}
