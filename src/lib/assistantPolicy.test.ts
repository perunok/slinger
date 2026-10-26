import { describe, expect, it } from 'vitest'
import { assistantControl, originDependsOn, redactValues, refusal, scriptSecretDenial } from './assistantPolicy'
import { newDraft } from './request'
import { layeredScope } from './template'

const scope = layeredScope({
  environmentName: 'Local',
  environment: [
    { key: 'baseUrl', value: 'https://api.example.com', secret: false },
    { key: 'host', value: 'api.example.com', secret: false },
    { key: 'viaHost', value: 'https://{{host}}/v1', secret: false },
    { key: 'userId', value: '42', secret: false },
    { key: 'token', value: null, secret: true, id: 'v1' },
  ],
})
const none = { requests: [], variables: [] }

describe('assistantControl', () => {
  it('says why the assistant controls a send', () => {
    expect(assistantControl(undefined, none, 'r1', 'e1').reasons).toEqual([])
    expect(assistantControl({ adHoc: true }, none, null, 'e1')).toMatchObject({ reasons: ['it is an ad-hoc request'], ownAuth: true })
    expect(assistantControl({ overrides: ['url'] }, none, 'r1', 'e1').reasons).toEqual(['it is sent with changed url'])
    const changed = { requests: [{ requestId: 'r1', created: true }], variables: [{ environmentId: 'e1', key: 'baseUrl' }, { environmentId: 'e2', key: 'x' }] }
    const c = assistantControl(undefined, changed, 'r1', 'e1')
    expect(c.ownAuth).toBe(true)
    expect([...c.assistantVariables]).toEqual(['baseUrl'])
    expect(assistantControl({ overrides: ['auth'] }, changed, 'r1', 'e1').ownAuth).toBe(false)
  })

  it('denies secrets to scripts when anything is the assistant’s', () => {
    expect(scriptSecretDenial(assistantControl(undefined, none, 'r1', 'e1'))).toBeNull()
    expect(scriptSecretDenial(assistantControl({ adHoc: true }, none, null, null))).toMatch(/AI assistant/)
    expect(scriptSecretDenial(assistantControl(undefined, { requests: [], variables: [{ environmentId: 'e1', key: 'userId' }] }, 'r1', 'e1'))).toMatch(/userId/)
  })
})

describe('originDependsOn', () => {
  it('finds variables that decide scheme, host or port, directly or through other variables', () => {
    expect(originDependsOn('{{baseUrl}}/users', scope, new Set(['baseUrl']))).toEqual(['baseUrl'])
    expect(originDependsOn('https://{{host}}/users', scope, new Set(['host']))).toEqual(['host'])
    expect(originDependsOn('{{viaHost}}/users', scope, new Set(['host']))).toEqual(['host'])
    expect(originDependsOn('https://api.example.com/users/{{userId}}', scope, new Set(['userId']))).toEqual([])
    expect(originDependsOn('{{baseUrl}}/users/{{userId}}', scope, new Set(['userId']))).toEqual([])
  })
})

describe('refusal', () => {
  const bearer = (token: string) => {
    const d = newDraft({ name: 'R', url: '{{baseUrl}}/x' })
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token } }
    return d
  }
  it('refuses credentials in what the assistant controls, allows its own', () => {
    const adHoc = assistantControl({ adHoc: true }, none, null, 'e1')
    expect(refusal(bearer('literal'), scope, adHoc)).toBeNull()
    expect(refusal(bearer('{{token}}'), scope, adHoc)).toMatch(/\{\{token\}\}/)
    const over = assistantControl({ overrides: ['url'] }, none, 'r1', 'e1')
    expect(refusal(bearer('literal'), scope, over, 'bearer')).toMatch(/saved authorization/)
    expect(refusal(newDraft({ name: 'R', url: 'https://x' }), scope, over, 'none')).toBeNull()
    const d = bearer('x')
    d.auth = { ...d.auth, kind: 'oauth2' }
    expect(refusal(d, scope, adHoc)).toMatch(/OAuth 2.0/)
  })
  it('refuses credentials going to a host an assistant-set variable decides', () => {
    const vars = assistantControl(undefined, { requests: [], variables: [{ environmentId: 'e1', key: 'baseUrl' }] }, 'r1', 'e1')
    expect(refusal(bearer('{{token}}'), scope, vars)).toMatch(/host set by the variable \{\{baseUrl\}\}/)
    expect(refusal(newDraft({ name: 'R', url: '{{baseUrl}}/x' }), scope, vars)).toBeNull()
  })
})

describe('redactValues', () => {
  it('replaces values and their URL-encoded form, longest first, ignoring very short ones', () => {
    expect(redactValues('a sk+1/x b sk%2B1%2Fx c', ['sk+1/x'])).toBe('a [hidden] b [hidden] c')
    expect(redactValues('abcdef abc', ['abc', 'abcdef'])).toBe('abcdef abc'.replace('abcdef', '[hidden]'))
    expect(redactValues('id 42', ['42'])).toBe('id 42')
  })
})
