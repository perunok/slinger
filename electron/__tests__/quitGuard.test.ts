import { describe, expect, it } from 'vitest'
import { discardPrompt, needsDiscardConfirm } from '../lib/quitGuard'

describe('quitting with unsaved edits that would be lost', () => {
  const base = { titles: ['Get user'], automated: false, sessionEnding: false, confirmed: false }

  it('asks only when something would be lost and nobody has answered yet', () => {
    expect(needsDiscardConfirm(base)).toBe(true)
    expect(needsDiscardConfirm({ ...base, titles: [] })).toBe(false)
    expect(needsDiscardConfirm({ ...base, confirmed: true })).toBe(false)
  })

  it('never blocks automated runs (hidden window) or an ending OS session on a dialog', () => {
    expect(needsDiscardConfirm({ ...base, automated: true })).toBe(false)
    expect(needsDiscardConfirm({ ...base, sessionEnding: true })).toBe(false)
  })

  it('names the count and the tabs; Cancel is the default and the Escape answer', () => {
    const one = discardPrompt(['Get user'])
    expect(one.message).toBe('Quit and discard 1 unsaved change?')
    expect(one.detail).toContain('• Get user')
    expect(one.buttons[one.cancelId]).toBe('Cancel')
    expect(one.defaultId).toBe(one.cancelId)
    const many = discardPrompt(Array.from({ length: 12 }, (_, i) => `Tab ${i + 1}`))
    expect(many.message).toBe('Quit and discard 12 unsaved changes?')
    expect(many.detail).toContain('• Tab 8')
    expect(many.detail).not.toContain('• Tab 9')
    expect(many.detail).toContain('… and 4 more')
  })
})
