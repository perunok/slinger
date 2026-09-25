import { describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import { SNIPPET_LANGS, generateSnippet, type SnippetLang } from './snippets'

function req(over: Partial<HttpRequestInput> = {}): HttpRequestInput {
  return {
    method: 'GET',
    url: 'https://api.example.com/items',
    headers: [],
    auth: { kind: 'none' },
    body: { mode: 'none' },
    workspaceId: 'w',
    ...over,
  }
}

const ALL = SNIPPET_LANGS.map((l) => l.id)
const raw = (content: string, contentType = 'application/json'): HttpRequestInput['body'] => ({
  mode: 'raw',
  raw: { content, contentType },
})

describe('SNIPPET_LANGS', () => {
  it('lists every language with editor language', () => {
    expect(ALL).toEqual(['curl', 'fetch', 'axios', 'python', 'go', 'php', 'powershell'])
    expect(SNIPPET_LANGS.find((l) => l.id === 'fetch')?.editorLanguage).toBe('javascript')
    expect(SNIPPET_LANGS.find((l) => l.id === 'axios')?.editorLanguage).toBe('javascript')
  })
})

describe('basics for every language', () => {
  it.each(ALL)('%s includes method, url and headers, skips empty keys', (lang) => {
    const out = generateSnippet(
      lang,
      req({ method: 'delete', headers: [{ key: 'X-A', value: '1' }, { key: '', value: 'skip' }, { key: '  ', value: 'skip2' }] }),
    )
    expect(out).toContain('https://api.example.com/items')
    expect(out.toLowerCase()).toContain('delete')
    expect(out).toContain('X-A')
    expect(out).not.toContain('skip')
  })
  it.each(ALL)('%s leaves {{vars}} untouched', (lang) => {
    const out = generateSnippet(lang, req({ url: '{{base}}/x', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] }))
    expect(out).toContain('{{base}}/x')
    expect(out).toContain('{{token}}')
  })
})

describe('auth', () => {
  const basic = req({ auth: { kind: 'basic', basic: { username: 'user', password: 'pässword' } } })
  const expected = btoa(String.fromCharCode(...new TextEncoder().encode('user:pässword')))
  it.each(ALL)('%s basic uses utf-8 base64', (lang) => {
    expect(generateSnippet(lang, basic)).toContain(`Basic ${expected}`)
  })
  it.each(ALL)('%s bearer', (lang) => {
    expect(generateSnippet(lang, req({ auth: { kind: 'bearer', bearer: { token: 'tok123' } } }))).toContain('Bearer tok123')
  })
  it.each(ALL)('%s apiKey header', (lang) => {
    const out = generateSnippet(lang, req({ auth: { kind: 'apiKey', apiKey: { key: 'X-Api-Key', value: 'k1', addTo: 'header' } } }))
    expect(out).toContain('X-Api-Key')
    expect(out).toContain('k1')
  })
  it('apiKey query is appended to url (with existing query and fragment)', () => {
    const out = generateSnippet(
      'curl',
      req({ url: 'https://a.io/p?x=1#frag', auth: { kind: 'apiKey', apiKey: { key: 'api key', value: 'a&b', addTo: 'query' } } }),
    )
    expect(out).toContain("'https://a.io/p?x=1&api%20key=a%26b#frag'")
    const plain = generateSnippet('curl', req({ auth: { kind: 'apiKey', apiKey: { key: 'k', value: 'v', addTo: 'query' } } }))
    expect(plain).toContain('items?k=v')
  })
  it('user Authorization header wins over auth', () => {
    const out = generateSnippet(
      'curl',
      req({ headers: [{ key: 'authorization', value: 'Custom x' }], auth: { kind: 'bearer', bearer: { token: 'no' } } }),
    )
    expect(out).toContain('authorization: Custom x')
    expect(out).not.toContain('Bearer')
  })
})

describe('curl', () => {
  it('simple GET', () => {
    expect(generateSnippet('curl', req())).toBe("curl 'https://api.example.com/items'")
  })
  it('escapes single quotes', () => {
    const out = generateSnippet('curl', req({ method: 'POST', body: raw(`it's "q"`, 'text/plain') }))
    expect(out).toContain(`--data-raw 'it'\\''s "q"'`)
  })
  it('preserves newlines and unicode literally inside single quotes', () => {
    const out = generateSnippet('curl', req({ method: 'POST', body: raw('a\nb ✓ $HOME `x`', 'text/plain') }))
    expect(out).toContain("--data-raw 'a\nb ✓ $HOME `x`'")
  })
  it('raw body with content type, dedupes user Content-Type case-insensitively', () => {
    const a = generateSnippet('curl', req({ method: 'POST', body: raw('{}') }))
    expect(a).toContain("-H 'Content-Type: application/json'")
    const b = generateSnippet('curl', req({ method: 'POST', headers: [{ key: 'content-type', value: 'text/x' }], body: raw('{}') }))
    expect(b).toContain("-H 'content-type: text/x'")
    expect(b).not.toContain('application/json')
    expect(b.match(/content-type/gi)).toHaveLength(1)
  })
  it('urlEncoded uses data-urlencode, skips disabled', () => {
    const out = generateSnippet(
      'curl',
      req({
        method: 'POST',
        body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: 'b c', enabled: true }, { key: 'off', value: '1', enabled: false }] },
      }),
    )
    expect(out).toContain("--data-urlencode 'a=b c'")
    expect(out).not.toContain('off')
  })
  it('formData text and file', () => {
    const out = generateSnippet(
      'curl',
      req({
        method: 'POST',
        body: {
          mode: 'formData',
          formData: [
            { key: 'name', value: '@literal', type: 'text', enabled: true },
            { key: 'file', value: '', filePath: '/tmp/a b.png', type: 'file', enabled: true },
            { key: 'skip', value: 'x', type: 'text', enabled: false },
          ],
        },
      }),
    )
    expect(out).toContain("--form-string 'name=@literal'")
    expect(out).toContain("-F 'file=@/tmp/a b.png'")
    expect(out).not.toContain('skip')
  })
  it('drops boundary-less multipart Content-Type header for formData', () => {
    const out = generateSnippet(
      'curl',
      req({
        method: 'POST',
        headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
        body: { mode: 'formData', formData: [{ key: 'a', value: '1', type: 'text', enabled: true }] },
      }),
    )
    expect(out).not.toMatch(/content-type/i)
  })
  it('binary', () => {
    const out = generateSnippet('curl', req({ method: 'PUT', body: { mode: 'binary', binaryFilePath: '/tmp/x.bin' } }))
    expect(out).toContain("-X PUT")
    expect(out).toContain("--data-binary '@/tmp/x.bin'")
  })
  it('GET with body still sets -X, HEAD uses --head', () => {
    expect(generateSnippet('curl', req({ body: raw('x', 'text/plain') }))).toContain('-X GET')
    expect(generateSnippet('curl', req({ method: 'HEAD' }))).toContain('--head')
  })
  it('empty raw content means no body', () => {
    const out = generateSnippet('curl', req({ method: 'POST', body: raw('') }))
    expect(out).not.toContain('--data')
    expect(out).not.toContain('Content-Type')
  })
})

describe('fetch', () => {
  it('escapes strings via JS literals', () => {
    const out = generateSnippet('fetch', req({ method: 'POST', body: raw('he said "hi"\n\\ ✓ \u2028', 'text/plain') }))
    expect(out).toContain('body: "he said \\"hi\\"\\n\\\\ ✓ \\u2028"')
    expect(out).toContain('method: "POST"')
    expect(out).toContain('"Content-Type": "text/plain"')
  })
  it('urlEncoded and formData', () => {
    const u = generateSnippet('fetch', req({ method: 'POST', body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: '1', enabled: true }] } }))
    expect(u).toContain('new URLSearchParams([')
    expect(u).toContain('["a", "1"]')
    const f = generateSnippet(
      'fetch',
      req({
        method: 'POST',
        body: {
          mode: 'formData',
          formData: [
            { key: 't', value: 'v', type: 'text', enabled: true },
            { key: 'f', value: '', filePath: 'C:\\dir\\a.txt', type: 'file', enabled: true },
          ],
        },
      }),
    )
    expect(f).toContain("import { readFile } from 'node:fs/promises';")
    expect(f).toContain('form.append("t", "v");')
    expect(f).toContain('readFile("C:\\\\dir\\\\a.txt")')
    expect(f).toContain('"a.txt"')
    expect(f).toContain('body: form,')
  })
  it('binary reads file', () => {
    const out = generateSnippet('fetch', req({ method: 'POST', body: { mode: 'binary', binaryFilePath: '/t/x' } }))
    expect(out).toContain('await readFile("/t/x")')
    expect(out).toContain('body: body,')
  })
  it('duplicate header names use pair list', () => {
    const out = generateSnippet('fetch', req({ headers: [{ key: 'A', value: '1' }, { key: 'a', value: '2' }] }))
    expect(out).toContain('["A", "1"]')
    expect(out).toContain('["a", "2"]')
  })
  it('no body => no body key', () => {
    expect(generateSnippet('fetch', req())).not.toContain('body:')
  })
})

describe('axios', () => {
  it('uses lower-case method, data and headers', () => {
    const out = generateSnippet('axios', req({ method: 'POST', body: raw('{"a":1}') }))
    expect(out).toContain("import axios from 'axios';")
    expect(out).toContain('method: "post"')
    expect(out).toContain('data: "{\\"a\\":1}"')
    expect(out).toContain('"Content-Type": "application/json"')
  })
  it('collapses duplicate headers', () => {
    const out = generateSnippet('axios', req({ headers: [{ key: 'A', value: '1' }, { key: 'a', value: '2' }] }))
    expect(out).toContain('"A": "1, 2"')
  })
  it('formData/binary include fs import', () => {
    const out = generateSnippet('axios', req({ method: 'POST', body: { mode: 'binary', binaryFilePath: '/x' } }))
    expect(out.indexOf('readFile')).toBeLessThan(out.indexOf("from 'axios'") + 30)
    expect(out).toContain('data: body,')
  })
})

describe('python', () => {
  it('escapes quotes, backslashes, newlines and control chars', () => {
    const out = generateSnippet('python', req({ method: 'POST', body: raw("it's\\ \n\r\t\u0001 ✓", 'text/plain') }))
    expect(out).toContain("payload = 'it\\'s\\\\ \\n\\r\\t\\x01 ✓'")
    expect(out).toContain("data=payload.encode('utf-8')")
    expect(out).toContain("requests.request('POST', url, headers=headers")
  })
  it('urlEncoded', () => {
    const out = generateSnippet('python', req({ method: 'POST', body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: '1', enabled: true }] } }))
    expect(out).toContain("('a', '1'),")
    expect(out).toContain('data=payload')
  })
  it('formData uses files=', () => {
    const out = generateSnippet(
      'python',
      req({
        method: 'POST',
        body: {
          mode: 'formData',
          formData: [
            { key: 't', value: 'v', type: 'text', enabled: true },
            { key: 'f', value: '', filePath: '/tmp/a.png', type: 'file', enabled: true },
          ],
        },
      }),
    )
    expect(out).toContain("('t', (None, 'v')),")
    expect(out).toContain("('f', ('a.png', open('/tmp/a.png', 'rb'))),")
    expect(out).toContain('files=files')
  })
  it('binary', () => {
    const out = generateSnippet('python', req({ method: 'POST', body: { mode: 'binary', binaryFilePath: '/x' } }))
    expect(out).toContain("with open('/x', 'rb') as f:")
    expect(out).toContain('data=payload')
  })
  it('omits headers when there are none', () => {
    const out = generateSnippet('python', req())
    expect(out).not.toContain('headers')
    expect(out).toContain("requests.request('GET', url)")
  })
})

describe('go', () => {
  it('escapes strings and only imports what is used', () => {
    const out = generateSnippet('go', req({ method: 'POST', body: raw('a"b\\\n', 'text/plain') }))
    expect(out).toContain('strings.NewReader("a\\"b\\\\\\n")')
    expect(out).toContain('"strings"')
    expect(out).not.toContain('"os"')
    expect(out).toContain('http.NewRequest("POST", "https://api.example.com/items"')
    expect(out).toContain('req.Header.Add("Content-Type", "text/plain")')
  })
  it('GET has nil body and no strings import', () => {
    const out = generateSnippet('go', req())
    expect(out).toContain(', nil)')
    expect(out).not.toContain('"strings"')
  })
  it('urlEncoded', () => {
    const out = generateSnippet('go', req({ method: 'POST', body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: 'b', enabled: true }] } }))
    expect(out).toContain('url.QueryEscape("a") + "=" + url.QueryEscape("b")')
    expect(out).toContain('"net/url"')
  })
  it('formData with file', () => {
    const out = generateSnippet(
      'go',
      req({
        method: 'POST',
        body: {
          mode: 'formData',
          formData: [
            { key: 't', value: 'v', type: 'text', enabled: true },
            { key: 'f', value: '', filePath: '/tmp/a.png', type: 'file', enabled: true },
          ],
        },
      }),
    )
    expect(out).toContain('writer.WriteField("t", "v")')
    expect(out).toContain('writer.CreateFormFile("f", filepath.Base("/tmp/a.png"))')
    expect(out).toContain('req.Header.Set("Content-Type", writer.FormDataContentType())')
    for (const i of ['bytes', 'mime/multipart', 'os', 'path/filepath', 'io']) expect(out).toContain(`"${i}"`)
  })
  it('binary', () => {
    const out = generateSnippet('go', req({ method: 'POST', body: { mode: 'binary', binaryFilePath: '/x' } }))
    expect(out).toContain('os.Open("/x")')
    expect(out).toContain(', file)')
  })
})

describe('php', () => {
  it('uses single quotes, escaping only backslash and quote, keeps $', () => {
    const out = generateSnippet('php', req({ method: 'POST', body: raw("it's $x \\ \n✓", 'text/plain') }))
    expect(out).toContain("CURLOPT_POSTFIELDS => 'it\\'s $x \\\\ \n✓',")
    expect(out).toContain("CURLOPT_CUSTOMREQUEST => 'POST',")
    expect(out).toContain("'Content-Type: text/plain',")
    expect(out.startsWith('<?php')).toBe(true)
  })
  it('urlEncoded, formData, binary', () => {
    const u = generateSnippet('php', req({ method: 'POST', body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: 'b', enabled: true }] } }))
    expect(u).toContain("urlencode('a') . '=' . urlencode('b'),")
    const f = generateSnippet(
      'php',
      req({
        method: 'POST',
        body: {
          mode: 'formData',
          formData: [
            { key: 't', value: 'v', type: 'text', enabled: true },
            { key: 'f', value: '', filePath: '/tmp/a.png', type: 'file', enabled: true },
          ],
        },
      }),
    )
    expect(f).toContain("'t' => 'v',")
    expect(f).toContain("'f' => new CURLFile('/tmp/a.png'),")
    const b = generateSnippet('php', req({ method: 'POST', body: { mode: 'binary', binaryFilePath: '/x' } }))
    expect(b).toContain("file_get_contents('/x')")
  })
  it('HEAD sets NOBODY', () => {
    expect(generateSnippet('php', req({ method: 'HEAD' }))).toContain('CURLOPT_NOBODY => true')
  })
})

describe('powershell', () => {
  it('doubles single quotes including typographic ones', () => {
    const out = generateSnippet('powershell', req({ method: 'POST', body: raw("it's \u2018x\u2019 $v `t \n", 'text/plain') }))
    expect(out).toContain("$body = 'it''s \u2018\u2018x\u2019\u2019 $v `t \n'")
    expect(out).toContain("-ContentType 'text/plain'")
    expect(out).toContain('-Body $body')
    expect(out).toContain("-Method 'POST'")
  })
  it('moves Content-Type out of the headers table', () => {
    const out = generateSnippet('powershell', req({ method: 'POST', headers: [{ key: 'X-A', value: '1' }], body: raw('{}') }))
    expect(out).toContain("'X-A' = '1'")
    expect(out).not.toContain("'Content-Type' =")
    expect(out).toContain("-ContentType 'application/json'")
  })
  it('urlEncoded, formData, binary', () => {
    const u = generateSnippet('powershell', req({ method: 'POST', body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: 'b c', enabled: true }] } }))
    expect(u).toContain("[uri]::EscapeDataString('a') + '=' + [uri]::EscapeDataString('b c')")
    const f = generateSnippet(
      'powershell',
      req({
        method: 'POST',
        body: {
          mode: 'formData',
          formData: [
            { key: 't', value: 'v', type: 'text', enabled: true },
            { key: 'f', value: '', filePath: 'C:\\a b\\x.png', type: 'file', enabled: true },
          ],
        },
      }),
    )
    expect(f).toContain("'t' = 'v'")
    expect(f).toContain("'f' = Get-Item -LiteralPath 'C:\\a b\\x.png'")
    expect(f).toContain('-Form $form')
    const b = generateSnippet('powershell', req({ method: 'POST', body: { mode: 'binary', binaryFilePath: '/x' } }))
    expect(b).toContain("-InFile '/x'")
  })
})

describe('body none', () => {
  it.each(ALL as SnippetLang[])('%s emits no body for none', (lang) => {
    const out = generateSnippet(lang, req())
    expect(out).not.toMatch(/--data|POSTFIELDS|payload\b.*=|-Body|data:/)
  })
})
