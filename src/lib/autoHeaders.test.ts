import { describe, expect, it } from 'vitest'
import { autoHeaders } from './autoHeaders'
import { newRow } from './kv'
import { newDraft } from './request'

describe('autoHeaders', () => {
  it('adds content type from body and auth header', () => {
    const d = newDraft()
    d.body = { ...d.body, kind: 'raw', rawLanguage: 'xml' }
    d.auth = { ...d.auth, kind: 'bearer' }
    const h = autoHeaders(d)
    expect(h.find((x) => x.key === 'Content-Type')?.value).toBe('application/xml')
    expect(h.find((x) => x.key === 'Authorization')?.value).toContain('Bearer')
  })
  it('defers to user-defined headers', () => {
    const d = newDraft()
    d.body = { ...d.body, kind: 'raw' }
    d.headers = [newRow({ key: 'content-type', value: 'text/plain' })]
    expect(autoHeaders(d).some((x) => x.key === 'Content-Type')).toBe(false)
  })
})
