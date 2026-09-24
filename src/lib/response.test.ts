import { describe, expect, it } from 'vitest'
import type { HttpResponseData } from '../../shared/types'
import {
  LARGE_BODY_BYTES,
  analyzeResponse,
  base64ToBytes,
  bytesToBase64,
  dataUrl,
  formatBytes,
  formatDuration,
  parseCsv,
  parseSetCookies,
  prettyPrint,
  searchMatches,
  statusTone,
  textToBase64,
  truncateForDisplay,
} from './response'

function res(over: Partial<HttpResponseData> & { ct?: string }): HttpResponseData {
  const { ct, ...rest } = over
  return {
    status: 200,
    statusText: 'OK',
    durationMs: 1,
    headers: ct === undefined ? [] : [{ key: 'Content-Type', value: ct }],
    bodyText: null,
    bodyBase64: null,
    bodyByteLength: 0,
    ...rest,
  }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('analyzeResponse', () => {
  it('detects json by mime, case-insensitive with params', () => {
    const r = analyzeResponse(res({ ct: 'Application/JSON; charset=utf-8', bodyText: '{"a":1}', bodyByteLength: 7 }))
    expect(r.kind).toBe('json')
    expect(r.language).toBe('json')
    expect(r.mime).toBe('application/json')
    expect(r.text).toBe('{"a":1}')
    expect(r.byteLength).toBe(7)
  })
  it('treats +json as json even when invalid', () => {
    expect(analyzeResponse(res({ ct: 'application/problem+json', bodyText: 'oops' })).kind).toBe('json')
  })
  it('sniffs json in text/plain and with no content-type', () => {
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: ' [1,2] ' })).kind).toBe('json')
    expect(analyzeResponse(res({ bodyText: '{"x":true}' })).kind).toBe('json')
  })
  it('does not treat plain numbers/words as json', () => {
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: '123' })).kind).toBe('text')
    expect(analyzeResponse(res({ bodyText: 'hello world' })).kind).toBe('text')
  })
  it('detects xml by mime and by sniffing', () => {
    expect(analyzeResponse(res({ ct: 'application/atom+xml', bodyText: 'x' })).kind).toBe('xml')
    expect(analyzeResponse(res({ ct: 'text/xml', bodyText: '<a/>' })).kind).toBe('xml')
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: '<?xml version="1.0"?><a/>' })).kind).toBe('xml')
    expect(analyzeResponse(res({ bodyText: '<root><a>1</a></root>' })).kind).toBe('xml')
    expect(analyzeResponse(res({ bodyText: '<a>1</a>' })).language).toBe('xml')
  })
  it('detects html by mime and by sniffing', () => {
    expect(analyzeResponse(res({ ct: 'text/html; charset=utf-8', bodyText: 'hi' })).kind).toBe('html')
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: '<!DOCTYPE html><html></html>' })).kind).toBe('html')
    expect(analyzeResponse(res({ bodyText: '  <HTML lang="en"></HTML>' })).language).toBe('html')
  })
  it('detects csv by mime and by consistent columns', () => {
    expect(analyzeResponse(res({ ct: 'text/csv', bodyText: 'a' })).kind).toBe('csv')
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: 'a,b\n1,2\n3,4' })).kind).toBe('csv')
    expect(analyzeResponse(res({ bodyText: 'a;b;c\r\n1;2;3\r\n' })).kind).toBe('csv')
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: 'Hello, world\nThis is fine, mostly, ok' })).kind).toBe('text')
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: 'single, line' })).kind).toBe('text')
  })
  it('detects images from bytes regardless of mime', () => {
    const r = analyzeResponse(res({ ct: 'application/octet-stream', bodyBase64: bytesToBase64(PNG), bodyByteLength: PNG.length }))
    expect(r.kind).toBe('image')
    expect(r.mime).toBe('image/png')
    expect(r.base64).toBe(bytesToBase64(PNG))
    expect(r.text).toBeNull()
  })
  it('detects jpeg, gif, webp, bmp, ico magic bytes', () => {
    const mk = (b: number[], pad = 30) => bytesToBase64(Uint8Array.from([...b, ...new Array(pad).fill(0)]))
    expect(analyzeResponse(res({ bodyBase64: mk([0xff, 0xd8, 0xff, 0xe0]) })).mime).toBe('image/jpeg')
    expect(analyzeResponse(res({ bodyBase64: mk([...'GIF89a'].map((c) => c.charCodeAt(0))) })).mime).toBe('image/gif')
    const webp = [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)))
    expect(analyzeResponse(res({ bodyBase64: mk(webp) })).mime).toBe('image/webp')
    expect(analyzeResponse(res({ bodyBase64: mk([0x42, 0x4d]) })).mime).toBe('image/bmp')
    expect(analyzeResponse(res({ bodyBase64: mk([0, 0, 1, 0]) })).mime).toBe('image/x-icon')
  })
  it('uses image/* mime when bytes are unknown', () => {
    expect(analyzeResponse(res({ ct: 'image/avif', bodyBase64: 'AAECAw==' })).kind).toBe('image')
  })
  it('detects svg as image with text and base64', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'
    const r = analyzeResponse(res({ ct: 'image/svg+xml', bodyText: svg }))
    expect(r.kind).toBe('image')
    expect(r.text).toBe(svg)
    expect(r.base64).toBe(textToBase64(svg))
    expect(r.language).toBe('xml')
    expect(analyzeResponse(res({ ct: 'text/plain', bodyText: '<?xml version="1.0"?>\n<svg></svg>' })).kind).toBe('image')
  })
  it('detects pdf', () => {
    const b = bytesToBase64(new TextEncoder().encode('%PDF-1.7\n\xff\xfe'))
    expect(analyzeResponse(res({ bodyBase64: b })).kind).toBe('pdf')
    expect(analyzeResponse(res({ ct: 'application/pdf', bodyBase64: 'AAEC' })).kind).toBe('pdf')
    expect(analyzeResponse(res({ bodyText: '%PDF-1.4 stuff' })).kind).toBe('pdf')
  })
  it('falls back to binary', () => {
    const r = analyzeResponse(res({ bodyBase64: 'AAECAwT/', bodyByteLength: 6 }))
    expect(r.kind).toBe('binary')
    expect(r.base64).toBe('AAECAwT/')
    expect(r.mime).toBe('application/octet-stream')
  })
  it('decodes text-ish mime with invalid utf-8 lossily', () => {
    const r = analyzeResponse(res({ ct: 'text/plain', bodyBase64: bytesToBase64(Uint8Array.from([0x68, 0x69, 0xff])) }))
    expect(r.kind).toBe('text')
    expect(r.text).toContain('hi')
  })
  it('handles empty', () => {
    expect(analyzeResponse(res({})).kind).toBe('empty')
    expect(analyzeResponse(res({ bodyText: '', bodyBase64: '' })).kind).toBe('empty')
    expect(analyzeResponse(res({ ct: 'application/json' })).kind).toBe('empty')
  })
  it('maps css/js languages', () => {
    expect(analyzeResponse(res({ ct: 'text/css', bodyText: 'a{}' })).language).toBe('css')
    expect(analyzeResponse(res({ ct: 'application/javascript', bodyText: 'x=1' })).language).toBe('javascript')
    expect(analyzeResponse(res({ ct: 'text/javascript', bodyText: 'x=1' })).kind).toBe('text')
  })
  it('never throws on garbage', () => {
    expect(() => analyzeResponse(res({ bodyBase64: '!!!not base64@@@' }))).not.toThrow()
    expect(() => analyzeResponse(null as unknown as HttpResponseData)).not.toThrow()
    expect(() => analyzeResponse({ headers: null } as unknown as HttpResponseData)).not.toThrow()
    expect(analyzeResponse(res({ bodyBase64: '###' })).kind).toBe('empty')
  })
  it('handles large bodies', () => {
    const big = 'a,b\n'.repeat(500_000)
    const r = analyzeResponse(res({ bodyText: big, bodyByteLength: big.length }))
    expect(r.kind).toBe('csv')
    expect(r.byteLength).toBe(big.length)
  })
  it('strips BOM for sniffing', () => {
    expect(analyzeResponse(res({ bodyText: '﻿{"a":1}' })).kind).toBe('json')
  })
})

describe('prettyPrint json', () => {
  it('indents with 2 spaces', () => {
    const r = prettyPrint('json', '{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[]}')
    expect(r.ok).toBe(true)
    expect(r.text).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2,\n    {\n      "c": null\n    }\n  ],\n  "d": {},\n  "e": []\n}')
    expect(JSON.parse(r.text)).toEqual(JSON.parse('{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[]}'))
  })
  it('preserves big numbers, escapes and structure characters in strings', () => {
    const r = prettyPrint('json', '{"n":12345678901234567890,"s":"a,b:{}\\"[x]","f":1.50e+3}')
    expect(r.text).toContain('12345678901234567890')
    expect(r.text).toContain('"a,b:{}\\"[x]"')
    expect(r.text).toContain('1.50e+3')
  })
  it('handles primitives', () => {
    expect(prettyPrint('json', ' 42 ').text).toBe('42')
    expect(prettyPrint('json', '"x"').text).toBe('"x"')
  })
  it('reports errors with position and returns original', () => {
    const src = '{\n  "a": 1,\n  "b": }'
    const r = prettyPrint('json', src)
    expect(r.ok).toBe(false)
    expect(r.text).toBe(src)
    expect(r.error).toBeTruthy()
    expect(r.error).toMatch(/line 3/)
  })
  it('reports errors for empty input', () => {
    const r = prettyPrint('json', '')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
  it('never reports json errors for other kinds', () => {
    for (const k of ['text', 'csv', 'binary', 'empty', 'image', 'pdf'] as const) {
      const r = prettyPrint(k, 'not json {')
      expect(r).toEqual({ text: 'not json {', ok: true })
    }
  })
})

describe('prettyPrint xml', () => {
  it('indents nested elements and keeps text inline', () => {
    const r = prettyPrint('xml', '<a><b>text</b><c x="1"/><d><e/></d></a>')
    expect(r.ok).toBe(true)
    expect(r.text).toBe('<a>\n  <b>text</b>\n  <c x="1"/>\n  <d>\n    <e/>\n  </d>\n</a>')
  })
  it('handles declaration, comments, cdata, doctype', () => {
    const r = prettyPrint('xml', '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><!-- hi > there --><a><![CDATA[<x>&]]></a>')
    expect(r.text).toBe('<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY x "y">]>\n<!-- hi > there -->\n<a><![CDATA[<x>&]]></a>')
  })
  it('handles > inside attribute quotes', () => {
    const r = prettyPrint('xml', '<a title="x > y" b=\'1>2\'><b/></a>')
    expect(r.text).toBe('<a title="x > y" b=\'1>2\'>\n  <b/>\n</a>')
  })
  it('re-indents already formatted xml and empty elements', () => {
    const r = prettyPrint('xml', '<a>\n      <b>\n <c></c>\n</b>\n</a>')
    expect(r.text).toBe('<a>\n  <b>\n    <c></c>\n  </b>\n</a>')
  })
  it('tolerates malformed input', () => {
    const r = prettyPrint('xml', '</a></a><b><c')
    expect(r.ok).toBe(true)
    expect(typeof r.text).toBe('string')
  })
})

describe('prettyPrint html/other', () => {
  it('returns trimmed html untouched', () => {
    const html = '<pre>  a\n   b </pre><script>var x = 1 </script>'
    expect(prettyPrint('html', `  ${html}\n`)).toEqual({ text: html, ok: true })
  })
})

describe('parseCsv', () => {
  it('parses basic rows and skips trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('handles quotes, escaped quotes, embedded delimiters and newlines', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"line1\nline2",z')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['line1\nline2', 'z'],
    ])
  })
  it('handles CRLF and CR', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([['a', '', 'c'], ['', '', '']])
  })
  it('auto-detects delimiters', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a|b\n1|2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b;c\n1,2;3')[0].length).toBeGreaterThan(1)
  })
  it('ignores delimiters inside quotes when detecting', () => {
    expect(parseCsv('"a,b,c";d\n"1,2,3";4')).toEqual([['a,b,c', 'd'], ['1,2,3', '4']])
  })
  it('respects explicit delimiter', () => {
    expect(parseCsv('a,b;c', ';')).toEqual([['a,b', 'c']])
  })
  it('handles empty input and BOM', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']])
  })
  it('handles unterminated quote', () => {
    expect(parseCsv('a,"b\nc')).toEqual([['a', 'b\nc']])
  })
})

describe('parseSetCookies', () => {
  it('parses attributes and flags', () => {
    const [c] = parseSetCookies([
      {
        key: 'Set-Cookie',
        value: 'sid=abc123; Domain=example.com; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=60; Secure; HttpOnly; SameSite=Lax',
      },
    ])
    expect(c).toEqual({
      name: 'sid',
      value: 'abc123',
      domain: 'example.com',
      path: '/',
      expires: 'Wed, 21 Oct 2015 07:28:00 GMT',
      maxAge: '60',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    })
  })
  it('defaults flags to false and value may contain =', () => {
    const [c] = parseSetCookies([{ key: 'set-cookie', value: 'a=b=c' }])
    expect(c).toEqual({ name: 'a', value: 'b=c', secure: false, httpOnly: false })
  })
  it('handles multiple headers, case-insensitive, ignoring others', () => {
    const cs = parseSetCookies([
      { key: 'SET-COOKIE', value: 'a=1' },
      { key: 'Content-Type', value: 'x=y' },
      { key: 'set-cookie', value: 'b=2; Secure' },
    ])
    expect(cs.map((c) => c.name)).toEqual(['a', 'b'])
    expect(cs[1].secure).toBe(true)
  })
  it('splits joined cookies without breaking Expires', () => {
    const cs = parseSetCookies([
      {
        key: 'Set-Cookie',
        value: 'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/, b=2; Expires=Thu, 22 Oct 2015 07:28:00 GMT, c=3; HttpOnly',
      },
    ])
    expect(cs.map((c) => [c.name, c.value])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
    expect(cs[0].expires).toBe('Wed, 21 Oct 2015 07:28:00 GMT')
    expect(cs[1].expires).toBe('Thu, 22 Oct 2015 07:28:00 GMT')
    expect(cs[2].httpOnly).toBe(true)
  })
  it('does not split on commas inside values', () => {
    const cs = parseSetCookies([{ key: 'Set-Cookie', value: 'a=x,y; Path=/' }])
    expect(cs).toHaveLength(1)
    expect(cs[0].value).toBe('x,y')
  })
  it('returns [] for none', () => {
    expect(parseSetCookies([])).toEqual([])
  })
})

describe('formatting', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB')
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })
  it('formatDuration', () => {
    expect(formatDuration(120)).toBe('120 ms')
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(1240)).toBe('1.24 s')
    expect(formatDuration(65000)).toBe('1 min 5 s')
    expect(formatDuration(NaN)).toBe('0 ms')
  })
  it('statusTone', () => {
    expect(statusTone(200)).toBe('success')
    expect(statusTone(204)).toBe('success')
    expect(statusTone(301)).toBe('info')
    expect(statusTone(404)).toBe('warning')
    expect(statusTone(500)).toBe('danger')
    expect(statusTone(0)).toBe('danger')
  })
})

describe('base64', () => {
  it('round-trips utf-8 text', () => {
    const s = 'héllo ✓ 😀 \u0000'
    expect(new TextDecoder().decode(base64ToBytes(textToBase64(s)))).toBe(s)
    expect(textToBase64('hi')).toBe('aGk=')
  })
  it('round-trips large byte arrays', () => {
    const b = new Uint8Array(200_000).map((_, i) => i % 251)
    expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual(Array.from(b))
  })
  it('is tolerant', () => {
    expect(Array.from(base64ToBytes('aGk'))).toEqual([104, 105])
    expect(Array.from(base64ToBytes('a G\nk='))).toEqual([104, 105])
    expect(Array.from(base64ToBytes('data:text/plain;base64,aGk='))).toEqual([104, 105])
    expect(Array.from(base64ToBytes('-_-_'))).toEqual(Array.from(base64ToBytes('+/+/')))
    expect(base64ToBytes('').length).toBe(0)
    expect(() => base64ToBytes('%%%')).not.toThrow()
    expect(base64ToBytes(undefined as unknown as string).length).toBe(0)
  })
  it('dataUrl', () => {
    expect(dataUrl('image/png', 'AAA=')).toBe('data:image/png;base64,AAA=')
  })
})

describe('truncateForDisplay / searchMatches', () => {
  it('does not truncate small text', () => {
    expect(truncateForDisplay('abc')).toEqual({ text: 'abc', truncated: false, totalChars: 3 })
  })
  it('truncates and reports total', () => {
    expect(truncateForDisplay('abcdef', 4)).toEqual({ text: 'abcd', truncated: true, totalChars: 6 })
    expect(LARGE_BODY_BYTES).toBe(2 * 1024 * 1024)
  })
  it('does not split surrogate pairs', () => {
    expect(truncateForDisplay('ab😀c', 3).text).toBe('ab')
  })
  it('counts matches', () => {
    expect(searchMatches('aAaA', 'a')).toBe(4)
    expect(searchMatches('aAaA', 'a', true)).toBe(2)
    expect(searchMatches('aaaa', 'aa')).toBe(2)
    expect(searchMatches('abc', '')).toBe(0)
    expect(searchMatches('abc', 'x')).toBe(0)
  })
})
