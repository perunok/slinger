/** The request Settings tab model (Postman protocolProfileBehavior): defaults, edits, round trip, executor input, export. */
import { describe, expect, it } from 'vitest'
import type { ApiRequest, Collection } from '../../shared/types'
import { buildPostmanCollection } from './postman'
import { prepareRequest } from './prepare'
import { newDraft, parseDocument, serializeDraft } from './request'
import {
  boolSetting,
  maxRedirectsSetting,
  protocolInput,
  setBoolSetting,
  setMaxRedirects,
  setStrictSsl,
  strictSslChoice,
} from './requestSettings'
import { makeScope } from './template'

const apiRequest = (doc: Record<string, unknown>): ApiRequest => ({
  id: 'r1',
  workspaceId: 'w',
  collectionId: 'c',
  folderId: null,
  name: 'R',
  method: 'GET',
  url: 'https://api.test/x',
  documentJson: JSON.stringify({ name: 'R', method: 'GET', url: 'https://api.test/x', ...doc }),
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  version: 1,
})
const collection: Collection = { id: 'c', workspaceId: 'w', name: 'C', createdAt: 1, updatedAt: 1, version: 1 }
const exported = (r: ApiRequest) => buildPostmanCollection({ collection, folders: [], requests: [r] }).item[0]!

describe('request settings', () => {
  it('defaults, and edits that store only what differs', () => {
    const d = newDraft()
    expect(d.protocolProfileBehavior).toEqual({})
    expect(boolSetting(d.protocolProfileBehavior, 'followRedirects')).toBe(true)
    expect(boolSetting(d.protocolProfileBehavior, 'followAuthorizationHeader')).toBe(false)
    expect(strictSslChoice(d.protocolProfileBehavior)).toBe('default')
    expect(maxRedirectsSetting(d.protocolProfileBehavior)).toBeNull()

    setBoolSetting(d, 'followRedirects', false)
    setBoolSetting(d, 'followOriginalHttpMethod', true)
    setStrictSsl(d, 'off')
    setMaxRedirects(d, '3')
    expect(d.protocolProfileBehavior).toEqual({ followRedirects: false, followOriginalHttpMethod: true, strictSSL: false, maxRedirects: 3 })

    setBoolSetting(d, 'followRedirects', true)
    setStrictSsl(d, 'default')
    setMaxRedirects(d, '10')
    expect(d.protocolProfileBehavior).toEqual({ followOriginalHttpMethod: true })
    setMaxRedirects(d, '5000')
    expect(d.protocolProfileBehavior.maxRedirects).toBe(1000)
    setMaxRedirects(d, '')
    setMaxRedirects(d, '-1')
    expect(d.protocolProfileBehavior).not.toHaveProperty('maxRedirects')
  })

  it('round-trips Postman keys unchanged, unknown ones included', () => {
    const ppb = { strictSSL: false, maxRedirects: 3, disableBodyPruning: true, tlsDisabledProtocols: ['TLSv1'] }
    const d = parseDocument(apiRequest({ protocolProfileBehavior: ppb }))
    expect(d.protocolProfileBehavior).toEqual(ppb)
    expect(JSON.parse(serializeDraft(d).documentJson).protocolProfileBehavior).toEqual(ppb)
    expect(exported(apiRequest({ protocolProfileBehavior: ppb })).protocolProfileBehavior).toEqual(ppb)
    // Nothing set: no key at all.
    const plain = serializeDraft(newDraft({ url: 'x' }))
    expect(JSON.parse(plain.documentJson)).not.toHaveProperty('protocolProfileBehavior')
    expect(exported(apiRequest({}))).not.toHaveProperty('protocolProfileBehavior')
  })

  it('reads documents imported before 0.29 from the kept Postman item, and `{}` clears them', () => {
    const source = { name: 'R', request: { method: 'GET' }, protocolProfileBehavior: { followRedirects: false } }
    const d = parseDocument(apiRequest({ source }))
    expect(d.protocolProfileBehavior).toEqual({ followRedirects: false })
    expect(exported(apiRequest({ source })).protocolProfileBehavior).toEqual({ followRedirects: false })
    setBoolSetting(d, 'followRedirects', true)
    const doc = JSON.parse(serializeDraft(d).documentJson)
    expect(doc.protocolProfileBehavior).toEqual({})
    expect(parseDocument(apiRequest(doc)).protocolProfileBehavior).toEqual({})
    expect(exported(apiRequest(doc))).not.toHaveProperty('protocolProfileBehavior')
  })

  it('becomes executor input (only valid, set values)', () => {
    expect(protocolInput({})).toEqual({})
    expect(protocolInput({ strictSSL: false, followRedirects: false, maxRedirects: 2.7, followAuthorizationHeader: 'yes', disableBodyPruning: true })).toEqual({
      strictSSL: false,
      followRedirects: false,
      maxRedirects: 2,
    })
    const d = newDraft({ url: 'https://api.test/x' })
    setStrictSsl(d, 'off')
    setBoolSetting(d, 'removeRefererHeaderOnRedirect', true)
    const res = prepareRequest(d, { workspaceId: 'w', scope: makeScope('Dev', []), secrets: new Map() })
    expect(res.ok && res.input).toMatchObject({ strictSSL: false, removeRefererHeaderOnRedirect: true })
    expect(res.ok && res.input).not.toHaveProperty('followRedirects')
  })
})
