/**
 * Which items the title bar (the top bar) shows, on which side, in which order. Persisted as JSON in
 * `localStorage['slinger.titleBarLayout']`: `{ v: 1, left: [...], right: [...], hidden: [...] }`.
 */

export const TITLE_BAR_ITEMS = ['menu', 'sidebar', 'workspace', 'sync', 'search', 'environment', 'rightPanel', 'shortcuts', 'settings', 'about'] as const
export type TitleBarItem = (typeof TITLE_BAR_ITEMS)[number]
export type TitleBarSide = 'left' | 'right' | 'hidden'

export interface TitleBarLayout {
  left: TitleBarItem[]
  right: TitleBarItem[]
  hidden: TitleBarItem[]
}

export const TITLE_BAR_LAYOUT_KEY = 'slinger.titleBarLayout'

export const DEFAULT_TITLE_BAR_LAYOUT: TitleBarLayout = {
  left: ['menu', 'sidebar', 'workspace', 'sync'],
  right: ['search', 'environment', 'rightPanel', 'shortcuts', 'settings', 'about'],
  hidden: [],
}

/** Settings stays reachable on screen: it is where the layout is changed back. */
export const ALWAYS_SHOWN: readonly TitleBarItem[] = ['settings']

export const TITLE_BAR_ITEM_LABELS: Record<TitleBarItem, string> = {
  menu: 'Menu button (Windows/Linux, custom title bar)',
  sidebar: 'Sidebar toggle',
  workspace: 'Workspace switcher',
  sync: 'Cloud sync status',
  search: 'Go to request',
  environment: 'Environment switcher',
  rightPanel: 'Right panel',
  shortcuts: 'Keyboard shortcuts',
  settings: 'Settings',
  about: 'About Slinger',
}

const isItem = (v: unknown): v is TitleBarItem => typeof v === 'string' && (TITLE_BAR_ITEMS as readonly string[]).includes(v)

/**
 * A valid layout from anything stored: unknown names and repeats are dropped (first place wins), Settings is never
 * hidden, and items the stored layout does not mention (e.g. added in a later version) go where the default puts them.
 */
export function sanitizeTitleBarLayout(raw: unknown): TitleBarLayout {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!o) return cloneLayout(DEFAULT_TITLE_BAR_LAYOUT)
  const seen = new Set<TitleBarItem>()
  const pick = (v: unknown): TitleBarItem[] => {
    const out: TitleBarItem[] = []
    for (const item of Array.isArray(v) ? v : []) {
      if (!isItem(item) || seen.has(item)) continue
      seen.add(item)
      out.push(item)
    }
    return out
  }
  const layout: TitleBarLayout = { left: pick(o.left), right: pick(o.right), hidden: pick(o.hidden) }
  for (const item of TITLE_BAR_ITEMS) {
    if (seen.has(item)) continue
    const side = sideInDefault(item)
    layout[side].push(item)
  }
  for (const item of ALWAYS_SHOWN) {
    if (layout.hidden.includes(item)) {
      layout.hidden = layout.hidden.filter((i) => i !== item)
      layout[sideInDefault(item) === 'hidden' ? 'right' : sideInDefault(item)].push(item)
    }
  }
  return layout
}

export function loadTitleBarLayout(text: string | null): TitleBarLayout {
  if (!text) return cloneLayout(DEFAULT_TITLE_BAR_LAYOUT)
  try {
    return sanitizeTitleBarLayout(JSON.parse(text))
  } catch {
    return cloneLayout(DEFAULT_TITLE_BAR_LAYOUT)
  }
}

export const serializeTitleBarLayout = (l: TitleBarLayout): string => JSON.stringify({ v: 1, left: l.left, right: l.right, hidden: l.hidden })

export function sideOf(layout: TitleBarLayout, item: TitleBarItem): TitleBarSide {
  return layout.left.includes(item) ? 'left' : layout.right.includes(item) ? 'right' : 'hidden'
}

/**
 * Moves `item` to `side` at `index` (clamped; default: the end). Moving within its own side reorders. Settings cannot
 * be hidden (the layout is returned unchanged).
 */
export function moveItem(layout: TitleBarLayout, item: TitleBarItem, side: TitleBarSide, index?: number): TitleBarLayout {
  if (side === 'hidden' && ALWAYS_SHOWN.includes(item)) return layout
  const next: TitleBarLayout = {
    left: layout.left.filter((i) => i !== item),
    right: layout.right.filter((i) => i !== item),
    hidden: layout.hidden.filter((i) => i !== item),
  }
  const list = next[side]
  const at = index === undefined ? list.length : Math.max(0, Math.min(list.length, index))
  list.splice(at, 0, item)
  return next
}

/** Keyboard reordering: up/down within the side, left/right to the neighbouring side (left | right | hidden). */
export function nudgeItem(layout: TitleBarLayout, item: TitleBarItem, direction: 'up' | 'down' | 'left' | 'right'): TitleBarLayout {
  const side = sideOf(layout, item)
  const index = layout[side].indexOf(item)
  if (direction === 'up') return index > 0 ? moveItem(layout, item, side, index - 1) : layout
  if (direction === 'down') return index < layout[side].length - 1 ? moveItem(layout, item, side, index + 1) : layout
  const order: TitleBarSide[] = ['left', 'right', 'hidden']
  const target = order[order.indexOf(side) + (direction === 'left' ? -1 : 1)]
  if (!target) return layout
  return moveItem(layout, item, target, Math.min(index, layout[target].length))
}

export const sameLayout = (a: TitleBarLayout, b: TitleBarLayout): boolean => serializeTitleBarLayout(a) === serializeTitleBarLayout(b)

function sideInDefault(item: TitleBarItem): 'left' | 'right' | 'hidden' {
  return sideOf(DEFAULT_TITLE_BAR_LAYOUT, item)
}

function cloneLayout(l: TitleBarLayout): TitleBarLayout {
  return { left: [...l.left], right: [...l.right], hidden: [...l.hidden] }
}
