import { describe, expect, it } from 'vitest'
import { fenceLanguage, highlightToHtml, renderDocs, sanitizeHtml, slugify } from './render'

/** Parses rendered HTML into a detached element for structural assertions. */
function dom(html: string): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  return box
}
const render = (md: string) => dom(renderDocs(md))

describe('sanitiser: XSS vectors', () => {
  const vectors: Array<[string, string]> = [
    ['script tag', '<script>window.__pwned = 1</script>hello'],
    ['img onerror', '<img src="x" onerror="window.__pwned=1">'],
    ['javascript: link', '[click](javascript:alert(1))'],
    ['javascript: link (raw html, entity-obfuscated)', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
    ['javascript: link (upper case, spaces)', '<a href="  JaVaScRiPt:alert(1)">x</a>'],
    ['data:text/html link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['data:text/html raw link', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['vbscript link', '<a href="vbscript:msgbox(1)">x</a>'],
    ['svg onload', '<svg onload="alert(1)"><circle r="4"/></svg>'],
    ['svg in img data uri with script is inert, but svg element itself is dropped', '<svg><script>alert(1)</script></svg>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object/embed', '<object data="x.swf"></object><embed src="x.swf">'],
    ['style tag', '<style>body{display:none}</style>'],
    ['style attribute / expression', '<p style="background:url(javascript:alert(1));width:expression(alert(1))">x</p>'],
    ['form action', '<form action="https://evil.example"><input name="password"><button formaction="javascript:alert(1)">go</button></form>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['base href', '<base href="https://evil.example/">'],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ['event handler on allowed tag', '<details open ontoggle="alert(1)"><summary>s</summary></details>'],
    ['math/mathml', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'],
    ['template', '<template><img src=x onerror=alert(1)></template>'],
    ['srcset', '<img srcset="https://evil.example/a.png 1x">'],
  ]
  for (const [name, md] of vectors) {
    it(`neutralises ${name}`, () => {
      const html = renderDocs(md)
      const box = dom(html)
      expect(box.querySelector('script, iframe, object, embed, style, form, svg, math, meta, base, link, template, button')).toBeNull()
      for (const el of Array.from(box.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.startsWith('on'), `${name}: ${attr.name}`).toBe(false)
          expect(['style', 'srcset', 'formaction', 'action', 'id', 'name']).not.toContain(attr.name)
          if (attr.name === 'href' || attr.name === 'src') expect(attr.value.replace(/\s/g, '')).not.toMatch(/^(javascript|vbscript|data:text)/i)
        }
      }
      expect(html).not.toMatch(/javascript:|vbscript:|onerror|onload|ontoggle|expression\(/i)
    })
  }

  it('keeps safe links: http(s), mailto, anchors, relative', () => {
    const box = render('[a](https://example.com/x) [b](http://h.test) [c](mailto:dev@example.com) [d](#usage) [e](other/page.md)')
    expect(Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/x',
      'http://h.test',
      'mailto:dev@example.com',
      '#usage',
      'other/page.md',
    ])
    // external links are marked and never get target/rel from the author
    expect(box.querySelector('a[href^="https"]')!.className).toBe('md-ext')
    expect(render('<a href="https://x.test" target="_blank">x</a>').querySelector('a')!.hasAttribute('target')).toBe(false)
  })

  it('filters class names so author HTML cannot reuse app utility classes', () => {
    const box = render('<div class="fixed inset-0 z-50 md-plain">overlay</div>')
    expect(box.querySelector('div')!.className).toBe('md-plain')
    expect(render('<span class="bg-accent">x</span>').querySelector('span')!.hasAttribute('class')).toBe(false)
  })

  it('only renders data:image sources; remote images become an "Open image" placeholder', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='
    const box = render(`![dot](${png}) ![remote logo](https://cdn.example.com/logo.png) ![rel](img/a.png) <img src="data:text/html,<b>x</b>" alt="bad">`)
    const imgs = box.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.getAttribute('src')).toBe(png)
    const blocked = Array.from(box.querySelectorAll('.md-img-blocked'))
    expect(blocked.map((b) => b.querySelector('.md-img-label')!.textContent)).toEqual(['remote logo', 'rel', 'bad'])
    expect(blocked[0]!.querySelector('a')!.getAttribute('href')).toBe('https://cdn.example.com/logo.png')
    expect(blocked[1]!.querySelector('a')).toBeNull()
  })

  it('task-list and stray inputs are disabled checkboxes', () => {
    const box = render('<input type="text" value="x">')
    const input = box.querySelector('input')
    expect(input?.getAttribute('type')).toBe('checkbox')
    expect(input?.hasAttribute('disabled')).toBe(true)
  })

  it('sanitizeHtml is usable on its own', () => {
    expect(sanitizeHtml('<b onclick="x()">ok</b><script>1</script>')).toBe('<b>ok</b>')
  })
})

describe('GFM rendering', () => {
  it('renders tables, task lists, strikethrough, autolinks, blockquotes, lists, hr, inline code and fenced code', () => {
    const md = [
      '# Title',
      '',
      '| Name | Type |',
      '|:-----|-----:|',
      '| id   | uuid |',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '1. one',
      '2. two',
      '',
      '~~old~~ and www.example.com and https://example.org',
      '',
      '> quoted',
      '',
      '---',
      '',
      'Use `GET /users`.',
      '',
      '```json',
      '{ "a": 1, "b": true, "c": "s" }',
      '```',
    ].join('\n')
    const box = render(md)
    expect(box.querySelector('h1')!.textContent).toContain('Title')
    expect(box.querySelectorAll('table th')).toHaveLength(2)
    expect(box.querySelector('table td')!.textContent).toBe('id')
    const boxes = box.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect(box.querySelector('del')!.textContent).toBe('old')
    expect(Array.from(box.querySelectorAll('a.md-ext')).map((a) => a.getAttribute('href'))).toEqual(['http://www.example.com', 'https://example.org'])
    expect(box.querySelector('blockquote')!.textContent).toContain('quoted')
    expect(box.querySelector('ol li')!.textContent).toBe('one')
    expect(box.querySelector('hr')).not.toBeNull()
    expect(box.querySelector('p code')!.textContent).toBe('GET /users')
    const pre = box.querySelector('pre.md-code')!
    expect(pre.querySelector('.md-code-lang')!.textContent).toBe('json')
    expect(pre.querySelector('.tok-property')!.textContent).toBe('"a"')
    expect(pre.querySelector('.tok-number')!.textContent).toBe('1')
    expect(pre.querySelector('.tok-bool')!.textContent).toBe('true')
    expect(pre.querySelector('.tok-string')!.textContent).toBe('"s"')
  })

  it('gives headings unique anchors (data-anchor, never id) with a # link', () => {
    const box = render('## Get users\n\n## Get users\n\n### Errors & codes\n\n## Call *{{baseUrl}}* `now`')
    const hs = Array.from(box.querySelectorAll('h2, h3'))
    expect(hs.map((h) => h.getAttribute('data-anchor'))).toEqual(['get-users', 'get-users-1', 'errors--codes', 'call-baseurl-now'])
    expect(hs.every((h) => !h.hasAttribute('id'))).toBe(true)
    expect(hs[0]!.querySelector('a.md-anchor')!.getAttribute('href')).toBe('#get-users')
  })

  it('escapes code exactly once', () => {
    const box = render('`a<b & &amp;`\n\n```\n<script>x</script>\n```')
    expect(box.querySelector('p code')!.textContent).toBe('a<b & &amp;')
    expect(box.querySelector('pre code')!.textContent).toBe('<script>x</script>\n'.trimEnd())
    expect(box.querySelector('script')).toBeNull()
  })

  it('renders plain-text descriptions verbatim (no Markdown, no HTML)', () => {
    const box = dom(renderDocs('# not a heading\n<b>not bold</b>', 'plain'))
    expect(box.querySelector('h1, b')).toBeNull()
    expect(box.querySelector('.md-plain')!.textContent).toBe('# not a heading\n<b>not bold</b>')
  })
})

describe('{{variables}}', () => {
  it('are highlighted in prose, inline code, code blocks and raw HTML, never resolved', () => {
    const md = 'Call {{baseUrl}}/users with `{{token}}`.\n\n```js\nfetch("{{baseUrl}}/x", { headers: { a: {{apiKey}} } })\n```\n\n<p>raw {{secretThing}}</p>'
    const box = render(md)
    const vars = Array.from(box.querySelectorAll('.md-var')).map((v) => v.textContent)
    expect(vars).toEqual(['{{baseUrl}}', '{{token}}', '{{baseUrl}}', '{{apiKey}}', '{{secretThing}}'])
  })

  it('code block variables nest correctly across token boundaries', () => {
    const html = highlightToHtml('const a = {{x}} + "{{y}}"', 'js')
    const box = dom(html)
    expect(Array.from(box.querySelectorAll('.md-var')).map((v) => v.textContent)).toEqual(['{{x}}', '{{y}}'])
    expect(box.textContent).toBe('const a = {{x}} + "{{y}}"')
  })
})

describe('helpers', () => {
  it('fenceLanguage and slugify', () => {
    expect(fenceLanguage('JSON title="x"')).toBe('json')
    expect(fenceLanguage(undefined)).toBe('')
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('&lt;tag&gt; — ok')).toBe('tag--ok')
  })
})
