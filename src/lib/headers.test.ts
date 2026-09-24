import { describe, expect, it } from 'vitest'
import { suggestHeaderNames, suggestHeaderValues } from './headers'

describe('header suggestions', () => {
  it('prefers prefix matches and hides exact matches', () => {
    expect(suggestHeaderNames('content-t')[0]).toBe('Content-Type')
    expect(suggestHeaderNames('Content-Type')).not.toContain('Content-Type')
    expect(suggestHeaderNames('')).toContain('Accept')
    expect(suggestHeaderNames('zzzz')).toEqual([])
  })
  it('offers content types for Content-Type only when the name matches', () => {
    expect(suggestHeaderValues('content-type', 'app')).toContain('application/json')
    expect(suggestHeaderValues('X-Custom', '')).toEqual([])
    expect(suggestHeaderValues('Authorization', '')).toEqual(['Bearer ', 'Basic '])
  })
})
