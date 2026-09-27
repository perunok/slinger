/**
 * The right side panel: open/closed, which panel it shows and its width, persisted as JSON in
 * `localStorage['slinger.rightPanel']` (`{ open, panel, width }`). Closed by default. The panels themselves are
 * registered in `panels.ts`. The app shell measures the room next to the main area and reports it in `room`; when the
 * panel does not fit it stays "open" but is not shown (`fitPanelWidth` returns null) until there is room again.
 */
import type { ResponsePosition } from '../../app/settings.svelte'

export const RIGHT_PANEL_KEY = 'slinger.rightPanel'
export const PANEL_MIN_WIDTH = 220
export const PANEL_MAX_WIDTH = 640
export const PANEL_DEFAULT_WIDTH = 320

/** Width the request editor keeps next to the panel; side by side it needs room for two panes. */
export function minMainWidth(position: ResponsePosition): number {
  return position === 'beside' ? 640 : 500
}

export function clampPanelWidth(n: number): number {
  return Number.isFinite(n) ? Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(n))) : PANEL_DEFAULT_WIDTH
}

/**
 * The width to show the panel at in an area `available` px wide (main area + panel), or null when even the minimum
 * width would squeeze the main area below `minMain`. `available` 0 means "not measured yet" (e.g. tests): use the
 * preferred width.
 */
export function fitPanelWidth(available: number, preferred: number, minMain: number): number | null {
  const want = clampPanelWidth(preferred)
  if (!available) return want
  const room = available - minMain
  if (room < PANEL_MIN_WIDTH) return null
  return Math.min(want, room)
}

interface Persisted {
  open: boolean
  panel: string
  width: number
}

function load(): Persisted {
  const fallback: Persisted = { open: false, panel: 'variables', width: PANEL_DEFAULT_WIDTH }
  try {
    const raw = JSON.parse(localStorage.getItem(RIGHT_PANEL_KEY) ?? 'null') as Partial<Persisted> | null
    if (!raw || typeof raw !== 'object') return fallback
    return {
      open: raw.open === true,
      panel: typeof raw.panel === 'string' && raw.panel ? raw.panel : fallback.panel,
      width: clampPanelWidth(Number(raw.width)),
    }
  } catch {
    return fallback
  }
}

class RightPanelState {
  #initial = load()
  open = $state(this.#initial.open)
  /** Id of the shown panel (see panels.ts; an unknown id falls back to the first panel). */
  panel = $state(this.#initial.panel)
  /** Preferred width in px (the shown width may be smaller when the window is narrow). */
  width = $state(this.#initial.width)
  /** Set by the app shell: false while there is not enough room to show the panel. */
  room = $state(true)

  #save() {
    try {
      localStorage.setItem(RIGHT_PANEL_KEY, JSON.stringify({ open: this.open, panel: this.panel, width: this.width }))
    } catch {
      /* storage unavailable: lasts for this session */
    }
  }
  setOpen(open: boolean) {
    this.open = open
    this.#save()
  }
  toggle() {
    this.setOpen(!this.open)
  }
  /** Opens the panel on `id`. */
  show(id: string) {
    this.panel = id
    this.open = true
    this.#save()
  }
  setWidth(px: number) {
    this.width = clampPanelWidth(px)
    this.#save()
  }
  /** Re-reads localStorage (tests). */
  reload() {
    const p = load()
    this.open = p.open
    this.panel = p.panel
    this.width = p.width
  }
}

export const rightPanel = new RightPanelState()
