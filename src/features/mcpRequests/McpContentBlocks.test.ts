import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '../../dev/mockBackend'
import McpContentBlocks, { base64ByteLength, BLOCK_TEXT_LIMIT, blockFileName, describeBlock } from './McpContentBlocks.svelte'

afterEach(cleanup)
beforeEach(() => {
  window.slinger = createMockBackend({ latencyMs: 0 })
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const calls = () => (window.slinger as unknown as { calls: { method: string; args: unknown[] }[] }).calls
const blocks = () => screen.getAllByTestId('mcp-block')

describe('describeBlock', () => {
  it('reads every content block type and falls back to JSON for anything else', () => {
    expect(describeBlock({ type: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' })
    expect(describeBlock({ type: 'image', data: PNG, mimeType: 'image/png' })).toMatchObject({ kind: 'image', mime: 'image/png', preview: true, byteLength: 70 })
    expect(describeBlock({ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' })).toMatchObject({ kind: 'audio', preview: false, byteLength: 3 })
    expect(describeBlock({ type: 'resource_link', uri: 'demo://x', name: 'x' })).toMatchObject({ kind: 'resource_link', uri: 'demo://x', name: 'x', title: '' })
    expect(describeBlock({ type: 'resource', resource: { uri: 'demo://r', text: 'abc' } })).toMatchObject({ kind: 'resource', text: 'abc', blob: null, byteLength: 3 })
    expect(describeBlock({ type: 'resource', resource: { uri: 'demo://logo.png', mimeType: 'image/png', blob: PNG } })).toMatchObject({ preview: true, text: null })
    expect(describeBlock({ type: 'video', url: 'x' })).toMatchObject({ kind: 'unknown', type: 'video' })
    expect(describeBlock('nope')).toMatchObject({ kind: 'unknown', type: 'string', json: '"nope"' })
    // Malformed fields never reach the DOM as a data: URL.
    expect(describeBlock({ type: 'image', data: 'not base64 !!', mimeType: 'image/png' })).toMatchObject({ preview: false })
    expect(describeBlock({ type: 'image', data: PNG, mimeType: 'text/html' })).toMatchObject({ preview: false })
    expect(describeBlock({ type: 'text', text: 5 })).toMatchObject({ kind: 'unknown' })
  })

  it('computes sizes and download names', () => {
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength('YQ==')).toBe(1)
    expect(base64ByteLength('YWI=')).toBe(2)
    expect(base64ByteLength('YWJj')).toBe(3)
    expect(blockFileName('image/png', 'demo://logo.png')).toBe('logo.png')
    expect(blockFileName('image/png', 'demo://users/42')).toBe('content.png')
    expect(blockFileName('audio/wav')).toBe('content.wav')
    expect(blockFileName('text/plain', 'file:///tmp/a%20b.txt?x=1')).toBe('a b.txt')
    expect(blockFileName('')).toBe('content.bin')
    expect(blockFileName('text/x-log')).toBe('content.txt')
  })
})

describe('McpContentBlocks', () => {
  it('shows the empty text when there are no blocks', () => {
    render(McpContentBlocks, { blocks: [], emptyText: 'The tool returned no content.' })
    expect(screen.getByTestId('mcp-blocks-empty')).toHaveTextContent('The tool returned no content.')
  })

  it('renders text blocks as plain text and copies them', async () => {
    const user = userEvent.setup()
    render(McpContentBlocks, { blocks: [{ type: 'text', text: 'line 1\n<b>not html</b>' }] })
    const [b] = blocks()
    expect(b).toHaveAttribute('data-kind', 'text')
    expect(b.querySelector('pre')!.textContent).toBe('line 1\n<b>not html</b>')
    expect(b.querySelector('b')).toBeNull()
    await user.click(within(b).getByRole('button', { name: 'Copy text' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('line 1\n<b>not html</b>'))
  })

  it('truncates very long text until Show all', async () => {
    render(McpContentBlocks, { blocks: [{ type: 'text', text: 'x'.repeat(BLOCK_TEXT_LIMIT + 10) }] })
    expect(blocks()[0].querySelector('pre')!.textContent!.length).toBe(BLOCK_TEXT_LIMIT)
    await fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(blocks()[0].querySelector('pre')!.textContent!.length).toBe(BLOCK_TEXT_LIMIT + 10)
  })

  it('shows images as data: URLs and saves them as base64', async () => {
    render(McpContentBlocks, { blocks: [{ type: 'image', data: PNG, mimeType: 'image/png' }] })
    expect(screen.getByAltText('Image content 1')).toHaveAttribute('src', `data:image/png;base64,${PNG}`)
    expect(blocks()[0]).toHaveTextContent('image/png · 70 B')
    await fireEvent.click(screen.getByRole('button', { name: 'Save image to file' }))
    await waitFor(() => expect(calls().find((c) => c.method === 'writeExportFile')?.args).toEqual(['content.png', PNG, 'base64']))
  })

  it('does not preview an image with a non-image type', () => {
    render(McpContentBlocks, { blocks: [{ type: 'image', data: PNG, mimeType: 'text/html' }] })
    expect(screen.queryByRole('img')).toBeNull()
    expect(blocks()[0]).toHaveTextContent('cannot be shown here')
  })

  it('offers audio as a download (the CSP has no media-src)', async () => {
    render(McpContentBlocks, { blocks: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }] })
    expect(document.querySelector('audio')).toBeNull()
    expect(blocks()[0]).toHaveTextContent('Audio is not played inside Slinger')
    await fireEvent.click(screen.getByRole('button', { name: 'Save audio to file' }))
    await waitFor(() => expect(calls().find((c) => c.method === 'writeExportFile')?.args).toEqual(['content.wav', 'UklGRg==', 'base64']))
  })

  it('renders resource links with title, URI and description', async () => {
    const user = userEvent.setup()
    render(McpContentBlocks, { blocks: [{ type: 'resource_link', uri: 'demo://readme', name: 'readme', title: 'Read me', description: 'The docs', mimeType: 'text/markdown' }] })
    const [b] = blocks()
    expect(b).toHaveAttribute('data-kind', 'resource_link')
    expect(b).toHaveTextContent('Read me')
    expect(b).toHaveTextContent('demo://readme')
    expect(b).toHaveTextContent('The docs')
    expect(b).toHaveTextContent('text/markdown')
    await user.click(within(b).getByRole('button', { name: 'Copy URI' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('demo://readme'))
  })

  it('renders embedded text and blob resources', async () => {
    render(McpContentBlocks, {
      blocks: [
        { type: 'resource', resource: { uri: 'demo://readme', mimeType: 'text/markdown', text: '# Demo' } },
        { type: 'resource', resource: { uri: 'demo://logo.png', mimeType: 'image/png', blob: PNG } },
        { type: 'resource', resource: { uri: 'demo://data.bin', mimeType: 'application/octet-stream', blob: 'AAEC' } },
      ],
    })
    const [text, img, bin] = blocks()
    expect(text).toHaveTextContent('demo://readme')
    expect(text.querySelector('pre')!.textContent).toBe('# Demo')
    expect(within(img).getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`)
    expect(bin).toHaveTextContent('Binary resource')
    await fireEvent.click(within(text).getByRole('button', { name: 'Save resource to file' }))
    await waitFor(() => expect(calls().find((c) => c.method === 'writeExportFile')?.args).toEqual(['content.md', '# Demo', 'utf8']))
    await fireEvent.click(within(bin).getByRole('button', { name: 'Save resource to file' }))
    await waitFor(() => expect(calls().filter((c) => c.method === 'writeExportFile').at(-1)?.args).toEqual(['data.bin', 'AAEC', 'base64']))
  })

  it('shows unknown blocks as JSON', () => {
    render(McpContentBlocks, { blocks: [{ type: 'video', url: 'x' }] })
    expect(blocks()[0]).toHaveTextContent('video')
    expect(blocks()[0].querySelector('pre')!.textContent).toContain('"url": "x"')
  })
})
