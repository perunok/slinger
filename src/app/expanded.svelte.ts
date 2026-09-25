/** Which sidebar tree rows are expanded (`collection:<id>` / `folder:<id>` keys), persisted in localStorage. */
const LS_EXPANDED = 'slinger.expanded'

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* ignore */
  }
  return new Set()
}

class ExpandedStore {
  keys = $state<ReadonlySet<string>>(load())

  set(key: string, open: boolean) {
    const next = new Set(this.keys)
    if (open) next.add(key)
    else next.delete(key)
    this.replace(next)
  }

  replace(next: ReadonlySet<string>) {
    this.keys = next
    try {
      localStorage.setItem(LS_EXPANDED, JSON.stringify([...next]))
    } catch {
      /* ignore */
    }
  }
}

export const expandedStore = new ExpandedStore()
