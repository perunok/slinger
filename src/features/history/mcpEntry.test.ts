import { describe, expect, it } from 'vitest'
import { dataRows } from '../../lib/kv'
import { serializeDraft } from '../../lib/request'
import { mcpDraftFromHistory, parseMcpDetail } from './mcpEntry'

describe('parseMcpDetail', () => {
  it('splits the operation from its target', () => {
    expect(parseMcpDetail('tools/call get_weather')).toEqual({ operation: 'tools/call', target: 'get_weather' })
    expect(parseMcpDetail('resources/read demo://users/{id} x')).toEqual({ operation: 'resources/read', target: 'demo://users/{id} x' })
    expect(parseMcpDetail('prompts/get')).toEqual({ operation: 'prompts/get', target: '' })
  })

  it('returns null for anything else', () => {
    expect(parseMcpDetail(null)).toBeNull()
    expect(parseMcpDetail('')).toBeNull()
    expect(parseMcpDetail('Edited request "x"')).toBeNull()
    expect(parseMcpDetail('tools/callx y')).toBeNull()
  })
})

describe('mcpDraftFromHistory', () => {
  it('rebuilds a Streamable HTTP draft with the tool', () => {
    const d = mcpDraftFromHistory({ url: '{{base}}/mcp', detail: 'tools/call get_weather', requestName: 'Weather' })
    expect(d.name).toBe('Weather')
    expect(d.method).toBe('MCP')
    expect(d.url).toBe('{{base}}/mcp')
    expect(d.mcp).toMatchObject({ transport: 'http', operation: 'tools/call', tool: 'get_weather', arguments: '{}' })
    expect(serializeDraft(d).url).toBe('{{base}}/mcp')
  })

  it('rebuilds a stdio draft from the command line, with a resource or a prompt', () => {
    const d = mcpDraftFromHistory({ url: 'npx -y  @demo/server {{dir}}', detail: 'resources/read demo://readme', requestName: null })
    expect(d.name).toBe('npx -y  @demo/server {{dir}}')
    expect(d.url).toBe('')
    expect(d.mcp).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@demo/server', '{{dir}}'], operation: 'resources/read', uri: 'demo://readme' })
    expect(serializeDraft(d).url).toBe('npx -y @demo/server {{dir}}')

    const p = mcpDraftFromHistory({ url: 'https://mcp.test/sse', detail: 'prompts/get greet', requestName: null })
    expect(p.mcp).toMatchObject({ transport: 'http', operation: 'prompts/get', prompt: 'greet' })
    expect(dataRows(p.mcp!.promptArguments)).toEqual([])
  })

  it('keeps the defaults when the row has no usable detail or url', () => {
    const d = mcpDraftFromHistory({ url: '', detail: null, requestName: null })
    expect(d.name).toBe('New MCP Request')
    expect(d.mcp).toMatchObject({ transport: 'http', operation: 'tools/call', tool: '' })
  })
})
