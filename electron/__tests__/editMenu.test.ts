import { describe, expect, it } from 'vitest'
import { editMenuTemplate, type EditMenuParams } from '../lib/editMenu'

const flags = (over: Partial<EditMenuParams['editFlags']> = {}): EditMenuParams['editFlags'] => ({
  canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false, ...over,
})
const roles = (t: ReturnType<typeof editMenuTemplate>) => t?.map((i) => i.role ?? i.type)

describe('editMenuTemplate', () => {
  it('gives text fields the standard edit menu, enabled from the edit flags', () => {
    const t = editMenuTemplate({ isEditable: true, selectionText: '', editFlags: flags({ canPaste: true, canSelectAll: true }) })
    expect(roles(t)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    expect(t?.find((i) => i.role === 'cut')?.enabled).toBe(false)
    expect(t?.find((i) => i.role === 'paste')?.enabled).toBe(true)
  })

  it('offers only Copy on selected read-only text', () => {
    expect(roles(editMenuTemplate({ isEditable: false, selectionText: 'hello', editFlags: flags({ canCopy: true }) }))).toEqual(['copy'])
  })

  it('shows nothing elsewhere', () => {
    expect(editMenuTemplate({ isEditable: false, selectionText: '  ', editFlags: flags() })).toBeNull()
  })
})
