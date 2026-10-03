import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TITLE_BAR_LAYOUT,
  TITLE_BAR_ITEMS,
  loadTitleBarLayout,
  moveItem,
  nudgeItem,
  sanitizeTitleBarLayout,
  serializeTitleBarLayout,
  sideOf,
  type TitleBarLayout,
} from './titleBarLayout'

const all = (l: TitleBarLayout) => [...l.left, ...l.right, ...l.hidden].sort()

describe('title bar layout', () => {
  it('defaults: menu, sidebar toggle, workspace and sync on the left, the rest on the right, nothing hidden', () => {
    expect(loadTitleBarLayout(null)).toEqual(DEFAULT_TITLE_BAR_LAYOUT)
    expect(all(DEFAULT_TITLE_BAR_LAYOUT)).toEqual([...TITLE_BAR_ITEMS].sort())
  })

  it('round-trips and repairs what is stored', () => {
    const custom: TitleBarLayout = { left: ['close', 'minimize', 'maximize', 'search', 'workspace'], right: ['settings', 'environment', 'sidebar'], hidden: ['about', 'shortcuts', 'sync', 'menu', 'rightPanel'] }
    expect(loadTitleBarLayout(serializeTitleBarLayout(custom))).toEqual(custom)
    for (const junk of ['{', '[]', 'null', '42']) expect(loadTitleBarLayout(junk), junk).toEqual(DEFAULT_TITLE_BAR_LAYOUT)
    // Unknown names and repeats go; items not mentioned (new in a later version) go where the default puts them.
    const repaired = sanitizeTitleBarLayout({ left: ['about', 'teleport', 'about'], right: ['about', 'workspace'], hidden: 'x' })
    expect(repaired.left).toEqual(['about', 'menu', 'sidebar', 'sync'])
    expect(repaired.right).toEqual(['workspace', 'search', 'environment', 'rightPanel', 'shortcuts', 'settings', 'minimize', 'maximize', 'close'])
    expect(repaired.hidden).toEqual([])
    expect(all(repaired)).toEqual([...TITLE_BAR_ITEMS].sort())
  })

  it('never hides Settings or the window buttons (they can move, e.g. to the left like macOS)', () => {
    const l = sanitizeTitleBarLayout({ left: [], right: [], hidden: ['settings', 'close', 'minimize'] })
    expect(l.right).toEqual(expect.arrayContaining(['settings', 'close', 'minimize']))
    expect(l.hidden).toEqual([])
    for (const item of ['settings', 'minimize', 'maximize', 'close'] as const) expect(moveItem(DEFAULT_TITLE_BAR_LAYOUT, item, 'hidden')).toBe(DEFAULT_TITLE_BAR_LAYOUT)
    const mac = moveItem(moveItem(moveItem(DEFAULT_TITLE_BAR_LAYOUT, 'close', 'left', 0), 'minimize', 'left', 1), 'maximize', 'left', 2)
    expect(mac.left.slice(0, 3)).toEqual(['close', 'minimize', 'maximize'])
    expect(mac.right).not.toContain('close')
  })

  it('moves items between sides and reorders them', () => {
    const a = moveItem(DEFAULT_TITLE_BAR_LAYOUT, 'environment', 'left', 0)
    expect(a.left).toEqual(['environment', 'menu', 'sidebar', 'workspace', 'sync'])
    expect(a.right).not.toContain('environment')
    const b = moveItem(a, 'about', 'hidden')
    expect(sideOf(b, 'about')).toBe('hidden')
    const c = moveItem(b, 'sync', 'left', 99)
    expect(c.left.at(-1)).toBe('sync')
  })

  it('nudges with the keyboard: up/down within a side, left/right across sides', () => {
    let l = nudgeItem(DEFAULT_TITLE_BAR_LAYOUT, 'workspace', 'up')
    expect(l.left).toEqual(['menu', 'workspace', 'sidebar', 'sync'])
    l = nudgeItem(nudgeItem(l, 'workspace', 'up'), 'workspace', 'up')
    expect(l.left).toEqual(['workspace', 'menu', 'sidebar', 'sync'])
    l = nudgeItem(l, 'sync', 'right')
    expect(l.right[3]).toBe('sync')
    l = nudgeItem(l, 'sync', 'right')
    expect(l.hidden).toEqual(['sync'])
    expect(nudgeItem(l, 'sync', 'right')).toBe(l)
    expect(nudgeItem(l, 'menu', 'left')).toBe(l)
  })
})
