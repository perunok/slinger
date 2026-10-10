import { describe, expect, it } from 'vitest'
import { methodColor as versionsMethodColor } from '../versions/helpers'
import { isMcpMethod, methodColor } from './method'

describe('methodColor', () => {
  it('maps HTTP verbs to their tokens, case-insensitively, and everything else to --m-other', () => {
    expect(methodColor('GET')).toBe('var(--m-get)')
    expect(methodColor('delete')).toBe('var(--m-delete)')
    expect(methodColor('OPTIONS')).toBe('var(--m-other)')
    expect(methodColor('MCP')).toBe('var(--m-other)')
    expect(methodColor('')).toBe('var(--m-other)')
  })

  it('is the one the versions views use', () => {
    expect(versionsMethodColor).toBe(methodColor)
  })
})

describe('isMcpMethod', () => {
  it('recognises the MCP method only', () => {
    expect(isMcpMethod('MCP')).toBe(true)
    expect(isMcpMethod('mcp')).toBe(true)
    expect(isMcpMethod('GET')).toBe(false)
    expect(isMcpMethod(null)).toBe(false)
    expect(isMcpMethod(undefined)).toBe(false)
  })
})
