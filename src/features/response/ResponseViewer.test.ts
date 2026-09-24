import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HttpResponseData } from '../../../shared/types'
import { createMockBackend } from '../../dev/mockBackend'
import { LARGE_BODY_BYTES, textToBase64 } from '../../lib/response'
import ResponseViewer from './ResponseViewer.svelte'

afterEach(cleanup)
beforeEach(() => {
  window.slinger = createMockBackend({ latencyMs: 0 })
})

function res(over: Partial<HttpResponseData> & { ct?: string; body?: string }): HttpResponseData {
  const body = over.body ?? null
  return {
    status: 200,
    statusText: 'OK',
    durationMs: 123,
    headers: over.ct ? [{ key: 'Content-Type', value: over.ct }] : [],
    bodyText: body,
    bodyBase64: null,
    bodyByteLength: body ? new TextEncoder().encode(body).length : 0,
    ...over,
  }
}
const editorText = () => document.querySelector('.cm-content')?.textContent ?? ''
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) })

describe('ResponseViewer', () => {
  it('shows status, time and size chips', () => {
    render(ResponseViewer, { data: res({ status: 404, statusText: 'Not Found', ct: 'application/json', body: '{"a":1}' }) })
    expect(screen.getByTestId('status-chip')).toHaveTextContent('404 Not Found')
    expect(screen.getByTestId('time-chip')).toHaveTextContent('123 ms')
    expect(screen.getByTestId('size-chip')).toHaveTextContent('7 B')
  })

  it('pretty-prints JSON and Raw shows it exactly as received', async () => {
    render(ResponseViewer, { data: res({ ct: 'application/json', body: '{"a":1,"b":[1,2]}' }), view: 'pretty' })
    expect(editorText()).toContain('"a": 1')
    cleanup()
    render(ResponseViewer, { data: res({ ct: 'application/json', body: '{"a":1,"b":[1,2]}' }), view: 'raw' })
    expect(editorText()).toBe('{"a":1,"b":[1,2]}')
  })

  it('sniffs JSON even with a wrong content type and never says "Invalid JSON" for non-JSON', () => {
    render(ResponseViewer, { data: res({ ct: 'text/plain', body: '{"x":true}' }) })
    expect(editorText()).toContain('"x": true')
    cleanup()
    render(ResponseViewer, { data: res({ ct: 'text/plain', body: 'plain words {not json' }) })
    expect(screen.queryByText(/invalid json/i)).toBeNull()
    expect(editorText()).toBe('plain words {not json')
  })

  it('reports a precise pretty-print problem for a broken JSON body and still shows it', () => {
    render(ResponseViewer, { data: res({ ct: 'application/json', body: '{"a": }' }) })
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not pretty-print this JSON body/)
    expect(editorText()).toBe('{"a": }')
  })

  it('formats XML and renders CSV as a table', () => {
    render(ResponseViewer, { data: res({ ct: 'application/xml', body: '<a><b>1</b></a>' }) })
    expect(editorText()).toContain('<b>1</b>')
    cleanup()
    render(ResponseViewer, { data: res({ ct: 'text/csv', body: 'id,name\n1,Ann\n2,Bob' }) })
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Bob' })).toBeInTheDocument()
  })

  it('previews HTML in a sandboxed iframe without scripts', () => {
    render(ResponseViewer, { data: res({ ct: 'text/html', body: '<h1>Hi</h1><script>alert(1)</script>' }), view: 'preview' })
    const frame = screen.getByTitle('HTML preview')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Hi</h1>')
  })

  it('renders images from bodyBase64 and handles PDFs', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    render(ResponseViewer, { data: res({ ct: 'image/png', bodyBase64: png, bodyByteLength: 70 }) })
    expect(screen.getByAltText('Response body')).toHaveAttribute('src', `data:image/png;base64,${png}`)
  })

  it('does not crash on binary bodies: info view plus hex dump in Raw', async () => {
    const bin = btoa(String.fromCharCode(0, 1, 2, 250, 251, 252, 0, 0, 65))
    const { rerender } = render(ResponseViewer, { data: res({ ct: 'application/octet-stream', bodyBase64: bin, bodyByteLength: 9 }) })
    expect(screen.getByText('Binary response')).toBeInTheDocument()
    await rerender({ view: 'raw' })
    expect(editorText()).toContain('00 01 02 fa fb fc 00 00 41')
  })

  it('truncates rendering above 2 MB and offers Show all', async () => {
    const big = 'x'.repeat(LARGE_BODY_BYTES + 1000)
    render(ResponseViewer, { data: res({ ct: 'text/plain', body: big }) })
    expect(screen.getByText(/Large body/)).toBeInTheDocument()
    expect(document.querySelector('.cm-content')!.textContent!.length).toBeLessThan(LARGE_BODY_BYTES)
    await fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.queryByText(/Large body/)).toBeNull()
  })

  it('lists headers and parsed cookies', async () => {
    const data = res({
      ct: 'application/json',
      body: '{}',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Set-Cookie', value: 'sid=abc; Path=/; HttpOnly; Secure' },
        { key: 'Set-Cookie', value: 'theme=dark; Max-Age=60' },
      ],
    })
    const { rerender } = render(ResponseViewer, { data, view: 'headers' })
    expect(screen.getByRole('table', { name: 'Response headers' })).toHaveTextContent('sid=abc')
    await rerender({ view: 'cookies' })
    const table = screen.getByRole('table', { name: 'Response cookies' })
    expect(table).toHaveTextContent('sid')
    expect(table).toHaveTextContent('Secure, HttpOnly')
    expect(table).toHaveTextContent('Max-Age 60')
    expect(tab('Cookies')).toHaveTextContent('2')
  })

  it('saves text bodies as utf8 and binary bodies as base64 through the export API', async () => {
    const calls = (window.slinger as unknown as { calls: { method: string; args: unknown[] }[] }).calls
    render(ResponseViewer, { data: res({ ct: 'application/json', body: '{"a":1}' }) })
    await fireEvent.click(screen.getByRole('button', { name: 'Save response to file' }))
    await new Promise((r) => setTimeout(r, 20))
    const w = calls.find((c) => c.method === 'writeExportFile')!
    expect(w.args).toEqual(['response.json', '{"a":1}', 'utf8'])
    cleanup()
    const b64 = textToBase64('binary\u0000')
    render(ResponseViewer, { data: res({ ct: 'application/octet-stream', bodyBase64: b64, bodyByteLength: 7 }) })
    await fireEvent.click(screen.getByRole('button', { name: 'Save response to file' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.filter((c) => c.method === 'writeExportFile').at(-1)!.args).toEqual(['response.bin', b64, 'base64'])
  })
})
