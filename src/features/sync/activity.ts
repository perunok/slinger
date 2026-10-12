/** Wording for the Sync activity dialog (pure). */
import type { SyncActivityItem, SyncEntityType, SyncRun } from '../../../shared/types'

export const CHANGE_LABEL: Record<SyncActivityItem['change'], string> = { created: 'New', updated: 'Edited', deleted: 'Deleted' }

export const TYPE_LABEL: Record<SyncEntityType, string> = {
  collection: 'Collection',
  folder: 'Folder',
  request: 'Request',
  environment: 'Environment',
  environment_variable: 'Variable',
  collection_version: 'Version',
  collection_variable: 'Collection variable',
  global_variable: 'Global',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "2 uploaded, 5 downloaded" / "Nothing to sync" / "Downloading the workspace: 40 items" / "Failed: …". */
export function runSummary(run: SyncRun): string {
  const parts: string[] = []
  if (run.uploadedCount) parts.push(`${run.uploadedCount} uploaded`)
  if (run.downloadedCount) parts.push(run.initial ? `${plural(run.downloadedCount, 'item')} downloaded` : `${run.downloadedCount} downloaded`)
  if (run.conflicts) parts.push(plural(run.conflicts, 'conflict'))
  const what = parts.join(', ')
  if (run.result === 'running') return what ? `In progress: ${what}` : 'In progress…'
  if (run.result === 'error') return what ? `Failed after ${what}` : 'Failed'
  return what || 'Nothing to sync'
}

export const triggerLabel = (run: SyncRun) => (run.initial ? 'First sync' : run.trigger === 'manual' ? 'Sync now' : 'Automatic')

/** "14:03:21" (today) or "12 Oct 14:03" for an epoch-ms time. */
export function runTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${time.slice(0, 5)}`
}

/** "1.2 s" / "340 ms" for a finished run. */
export function runDuration(run: SyncRun): string | null {
  if (run.finishedAt === null) return null
  const ms = Math.max(0, run.finishedAt - run.startedAt)
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** Pending items grouped by change, in the order New, Edited, Deleted (counts for the heading). */
export function pendingSummary(items: readonly SyncActivityItem[]): string {
  const n = (c: SyncActivityItem['change']) => items.filter((i) => i.change === c).length
  return (['created', 'updated', 'deleted'] as const)
    .filter((c) => n(c) > 0)
    .map((c) => `${n(c)} ${CHANGE_LABEL[c].toLowerCase()}`)
    .join(', ')
}
