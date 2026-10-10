// A tiny MCP server over stdio for electron/__tests__/mcpClient.test.ts (plain Node, the SDK's own server).
// Writes a line to stderr on start; FIXTURE_GREETING (environment) changes the echo prefix, to show env reaches the child.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'stdio-fixture', version: '2.0.0' }, { capabilities: { logging: {} } })
const prefix = process.env.FIXTURE_GREETING ?? 'echo'

server.registerTool('echo', { description: 'Echoes text', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `${prefix}: ${text}` }],
}))
server.registerTool('shout', { description: 'Writes text to stderr', inputSchema: { text: z.string() } }, async ({ text }) => {
  process.stderr.write(`shout ${text}\npartial line`)
  process.stderr.write(' completed\n')
  return { content: [{ type: 'text', text: 'ok' }] }
})
server.registerTool('spam', { description: 'Writes 100 KB to stderr' }, async () => {
  for (let i = 0; i < 1000; i++) process.stderr.write(`${String(i).padStart(4, '0')} ${'x'.repeat(95)}\n`)
  return { content: [{ type: 'text', text: 'ok' }] }
})
server.registerTool('exit', { description: 'Exits right after answering' }, async () => {
  setTimeout(() => process.exit(0), 20)
  return { content: [{ type: 'text', text: 'bye' }] }
})
server.registerTool('pid', { description: 'Process id' }, async () => ({ content: [{ type: 'text', text: String(process.pid) }] }))
server.registerTool('cwd', { description: 'Working directory' }, async () => ({ content: [{ type: 'text', text: process.cwd() }] }))

process.stderr.write('fixture started\n')
await server.connect(new StdioServerTransport())
