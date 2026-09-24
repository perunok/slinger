import type { HistoryEntry } from '../../../shared/types'

export interface DayGroup {
  /** Local date as YYYY-MM-DD. */
  key: string
  entries: HistoryEntry[]
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Groups entries (given newest first, `createdAt` in unix seconds) by local day, keeping order. */
export function groupByDay(entries: HistoryEntry[], _now: Date): DayGroup[] {
  const groups: DayGroup[] = []
  for (const e of entries) {
    const key = dayKey(new Date(e.createdAt * 1000))
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.entries.push(e)
    else groups.push({ key, entries: [e] })
  }
  return groups
}

export function dayLabel(key: string, now: Date): string {
  if (key === dayKey(now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (key === dayKey(y)) return 'Yesterday'
  const [yy, mm, dd] = key.split('-').map(Number)
  return new Date(yy, mm - 1, dd).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}
