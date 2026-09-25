/**
 * Tracks which saved local-file paths the main process currently lets requests read. Files are only
 * readable after the user picked them in this session (main-process allowlist, reset on restart),
 * so paths stored in saved requests show as "not granted" until chosen again.
 * Call inside a component: it registers an $effect.
 */
import { api } from './ipc'

export interface GrantedFiles {
  /** False only when the main process is known to have no grant for `path`; unknown counts as granted. */
  isStale(path: string): boolean
  /** Record a grant made by a successful pickFile call. */
  markGranted(path: string): void
}

export function trackGrantedFiles(getPaths: () => string[]): GrantedFiles {
  let granted = $state<ReadonlySet<string>>(new Set())
  let checked = $state<ReadonlySet<string>>(new Set())

  $effect(() => {
    const paths = [...new Set(getPaths().filter(Boolean))]
    if (paths.length === 0) return
    let live = true
    api()
      .grantedFiles(paths)
      .then((ok) => {
        if (!live) return
        granted = new Set([...granted, ...ok])
        checked = new Set([...checked, ...paths])
      })
      .catch(() => {
        /* cannot tell: do not flag anything */
      })
    return () => {
      live = false
    }
  })

  return {
    isStale: (path) => !!path && checked.has(path) && !granted.has(path),
    markGranted(path) {
      granted = new Set([...granted, path])
      checked = new Set([...checked, path])
    },
  }
}
