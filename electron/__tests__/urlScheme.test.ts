import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withDefaultScheme } from '../../shared/urlScheme'
import { normalizeUrl } from '../services/httpExecutor'
import { makeEnv, type TestEnv } from './helpers'

describe('URLs typed without a scheme (as Postman takes them)', () => {
  it('adds http, keeps explicit schemes, scheme-relative URLs and port 443', () => {
    expect(withDefaultScheme('example.com/x')).toBe('http://example.com/x')
    expect(withDefaultScheme(' localhost:3000/x?a=1 ')).toBe('http://localhost:3000/x?a=1')
    expect(withDefaultScheme('172.16.0.236:8088')).toBe('http://172.16.0.236:8088')
    expect(withDefaultScheme('//cdn.example.com/a')).toBe('http://cdn.example.com/a')
    expect(withDefaultScheme('api.example.com:443/v1')).toBe('https://api.example.com:443/v1')
    expect(withDefaultScheme('user:pass@api.example.com:443')).toBe('https://user:pass@api.example.com:443')
    expect(withDefaultScheme('example.com/x?port=:443')).toBe('http://example.com/x?port=:443')
    expect(withDefaultScheme('https://example.com')).toBe('https://example.com')
    expect(withDefaultScheme('HTTP://Example.com')).toBe('HTTP://Example.com')
    expect(withDefaultScheme('')).toBe('')
    expect(normalizeUrl('//host/x')).toBe('http://host/x')
  })
})

describe('places that used to require http:// accept a bare address', () => {
  let env: TestEnv
  let server: Server
  let port: number
  beforeEach(async () => {
    env = makeEnv()
    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/yaml' })
      res.end('openapi: 3.0.0\ninfo: {title: Bare, version: "1"}\npaths:\n  /x:\n    get: {responses: {"200": {description: ok}}}\n')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    env.cleanup()
  })

  it('the cloud address is stored with http:// added', async () => {
    const cfg = await env.api.setCloudConfig({ apiBaseUrl: '172.16.0.236:8088/', deviceName: 'Test' })
    expect(cfg.apiBaseUrl).toBe('http://172.16.0.236:8088')
    expect((await env.api.getCloudConfig()).apiBaseUrl).toBe('http://172.16.0.236:8088')
  })

  it('an OpenAPI document URL without a scheme is fetched', async () => {
    const preview = await env.api.previewOpenApi({ url: `127.0.0.1:${port}/openapi.yaml` })
    expect(preview.title).toBe('Bare')
  })

  it('a request sent with a bare host reaches the server over http', async () => {
    const res = await env.api.executeHttpRequest({ requestRunId: 'r1', workspaceId: (await env.api.listWorkspaces())[0]!.id, method: 'GET', url: `127.0.0.1:${port}/x`, headers: [], body: { mode: 'none' }, auth: { kind: 'none' } } as never)
    expect(res.status).toBe(200)
  })
})
