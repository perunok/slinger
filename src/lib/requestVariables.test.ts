import { describe, expect, it } from 'vitest'
import { newRow } from './kv'
import { newDraft } from './request'
import { describeVariable, usedVariables, variableNamesUsed, variablesInScope } from './requestVariables'
import { layeredScope, SECRET_MASK } from './template'

const scope = layeredScope({
  environmentName: 'Local',
  environment: [
    { key: 'baseUrl', value: 'https://api.test', secret: false },
    { key: 'token', value: null, secret: true, id: 'v1' },
  ],
  collectionId: 'c1',
  collectionName: 'Payments',
  collection: [{ key: 'version', value: 'v2', secret: false }, { key: 'baseUrl', value: 'https://shadowed', secret: false }],
  globals: [{ key: 'region', value: 'eu', secret: false }],
})

describe('request variables', () => {
  it('lists every distinct name used by URL, enabled headers and auth, in order of first use', () => {
    const d = newDraft({
      url: '{{baseUrl}}/{{version}}/pay?id={{$guid}}&x={{baseUrl}}',
      headers: [newRow({ key: 'X-Region', value: '{{region}}' }), newRow({ key: 'X-Off', value: '{{disabled}}', enabled: false })],
    })
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: '{{token}} {{missing}}' } }
    expect(variableNamesUsed(d)).toEqual(['baseUrl', 'version', '$guid', 'region', 'token', 'missing'])
  })

  it('resolves values and sources, masks secrets and flags unresolved names', () => {
    const d = newDraft({ url: '{{baseUrl}}/{{version}}/{{token}}/{{$timestamp}}/{{region}}/{{nope}}' })
    expect(usedVariables(d, scope)).toEqual([
      { name: 'baseUrl', status: 'resolved', value: 'https://api.test', source: 'Environment: Local' },
      { name: 'version', status: 'resolved', value: 'v2', source: 'Collection: Payments' },
      { name: 'token', status: 'secret', value: SECRET_MASK, source: 'Environment: Local' },
      { name: '$timestamp', status: 'builtin', value: expect.stringContaining('(generated on send)'), source: 'Built-in' },
      { name: 'region', status: 'resolved', value: 'eu', source: 'Globals' },
      { name: 'nope', status: 'unresolved', value: null, source: null },
    ])
    expect(describeVariable('token', scope).value).not.toContain('null')
  })

  it('lists the whole scope, narrowest first, secrets masked', () => {
    expect(variablesInScope(scope).map((v) => [v.key, v.label, v.shown])).toEqual([
      ['baseUrl', 'Environment: Local', 'https://api.test'],
      ['token', 'Environment: Local', SECRET_MASK],
      ['version', 'Collection: Payments', 'v2'],
      ['region', 'Globals', 'eu'],
    ])
  })
})
