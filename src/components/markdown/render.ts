/**
 * Documentation rendering: Markdown (GFM via `marked`) -> HTML, sanitised by DOMPurify with a strict allowlist.
 *
 * Security model (see docs/ARCHITECTURE.md, "Documentation rendering"):
 * - Author HTML is allowed only as a small set of formatting tags; no scripts, event handlers, styles, forms,
 *   iframes/objects/embeds, SVG/MathML, ids/names (no DOM clobbering) or data-* attributes except our own.
 * - `href` may be http(s), mailto, a `#fragment` or a relative path; everything else (javascript:, data:, vbscript:,
 *   file:, custom schemes) is removed. The view intercepts every click: http(s)/mailto go to the OS browser through
 *   `openExternalUrl`, fragments scroll inside the doc, nothing ever navigates the app window.
 * - Images: only `data:image/*` sources render (CSP allows `data:`). Remote or relative images are never fetched;
 *   they become a placeholder with the alt text and, for http(s) URLs, an "Open image" link.
 * - `class` values are filtered to the few classes this module emits (`md-*`, `tok-*`), so author HTML cannot reuse
 *   app utility classes to overlay or restyle the UI.
 * - `{{variables}}` are shown as highlighted tokens and never resolved, so no value (let alone a secret) is shown.
 */
import DOMPurify from 'dompurify'
import { Marked, type Token, type Tokens } from 'marked'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight'
import type { DescriptionFormat } from '../../lib/description'

// ---------------------------------------------------------------------------
// Code highlighting (static, CodeMirror's Lezer parsers, colours from --syn-* tokens via tok-* classes)
// ---------------------------------------------------------------------------

/** Same tag groups as the editor theme (components/editor/cm/theme.ts). */
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], class: 'tok-keyword' },
  { tag: [t.string, t.special(t.string), t.attributeValue, t.regexp], class: 'tok-string' },
  { tag: [t.number, t.integer, t.float], class: 'tok-number' },
  { tag: [t.bool, t.null, t.atom], class: 'tok-bool' },
  { tag: [t.propertyName, t.definition(t.propertyName)], class: 'tok-property' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.processingInstruction, t.meta, t.documentMeta], class: 'tok-comment' },
  { tag: [t.tagName, t.typeName, t.className], class: 'tok-tag' },
  { tag: [t.attributeName, t.variableName, t.function(t.variableName)], class: 'tok-attr' },
  { tag: [t.punctuation, t.bracket, t.angleBracket, t.separator, t.operator], class: 'tok-punct' },
])

type Parser = ReturnType<typeof json>['language']['parser']
const parsers = new Map<string, () => Parser>()
const lazy = (make: () => Parser) => {
  let p: Parser | null = null
  return () => (p ??= make())
}
const jsParser = lazy(() => javascript().language.parser)
const tsParser = lazy(() => javascript({ typescript: true }).language.parser)
const jsonParser = lazy(() => json().language.parser)
const xmlParser = lazy(() => xml().language.parser)
const htmlParser = lazy(() => html().language.parser)
const cssParser = lazy(() => css().language.parser)
for (const n of ['js', 'javascript', 'mjs', 'cjs', 'node', 'jsx']) parsers.set(n, jsParser)
for (const n of ['ts', 'typescript', 'tsx']) parsers.set(n, tsParser)
for (const n of ['json', 'jsonc', 'json5', 'geojson']) parsers.set(n, jsonParser)
for (const n of ['xml', 'svg', 'soap', 'wsdl', 'xsd']) parsers.set(n, xmlParser)
for (const n of ['html', 'htm', 'xhtml', 'vue', 'svelte']) parsers.set(n, htmlParser)
for (const n of ['css', 'scss', 'less']) parsers.set(n, cssParser)

/** Code blocks larger than this are shown without highlighting (keeps huge pasted payloads fast). */
const MAX_HIGHLIGHT_CHARS = 200_000
const VAR_RE = /\{\{[^{}\n]{1,200}\}\}/g

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Language id from a fence info string (` ```json title="x" ` -> "json"). */
export function fenceLanguage(info: string | undefined): string {
  return (info ?? '').trim().split(/\s+/)[0]!.toLowerCase().replace(/[^a-z0-9+#.-]/g, '')
}

/**
 * Highlighted HTML for a code block: `tok-*` spans from the Lezer parse, with `{{variables}}` wrapped in
 * `md-var` spans (split at every token boundary so the nesting is always valid).
 */
export function highlightToHtml(code: string, lang: string): string {
  const cuts = new Set<number>([0, code.length])
  const ranges: Array<{ from: number; to: number; cls: string }> = []
  const make = parsers.get(lang)
  if (make && code.length <= MAX_HIGHLIGHT_CHARS) {
    try {
      highlightTree(make().parse(code), highlighter, (from, to, cls) => {
        ranges.push({ from, to, cls })
        cuts.add(from)
        cuts.add(to)
      })
    } catch {
      ranges.length = 0 // parser trouble: plain text is fine
    }
  }
  const vars: Array<{ from: number; to: number }> = []
  for (const m of code.matchAll(VAR_RE)) {
    vars.push({ from: m.index, to: m.index + m[0].length })
    cuts.add(m.index)
    cuts.add(m.index + m[0].length)
  }
  const points = [...cuts].sort((a, b) => a - b)
  let out = ''
  let r = 0
  let v = 0
  let inVar = false
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!
    const to = points[i + 1]!
    while (v < vars.length && vars[v]!.to <= from) v++
    const wantVar = v < vars.length && vars[v]!.from <= from
    if (wantVar !== inVar) {
      out += wantVar ? '<span class="md-var">' : '</span>'
      inVar = wantVar
    }
    while (r < ranges.length && ranges[r]!.to <= from) r++
    const range = r < ranges.length && ranges[r]!.from <= from ? ranges[r]! : null
    const text = esc(code.slice(from, to))
    out += range ? `<span class="${range.cls}">${text}</span>` : text
  }
  if (inVar) out += '</span>'
  return out
}

/** Inline text with `{{variables}}` wrapped (used for inline code). */
function withVars(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(VAR_RE)) {
    out += esc(text.slice(last, m.index)) + `<span class="md-var">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const unescapeEntities = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** GitHub-style heading slug: lower case, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return (
    unescapeEntities(text)
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-') || 'section'
  )
}

/** Visible text of inline tokens (for heading slugs). */
function plainText(tokens: Token[]): string {
  return tokens.map((tok) => ('tokens' in tok && tok.tokens ? plainText(tok.tokens) : 'text' in tok ? String(tok.text) : '')).join('')
}

function createMarked(): { marked: Marked; resetSlugs: () => void } {
  const seen = new Map<string, number>()
  const marked = new Marked({
    gfm: true,
    breaks: false,
    async: false,
    extensions: [
      {
        name: 'templateVariable',
        level: 'inline',
        start: (src: string) => src.indexOf('{{') >= 0 ? src.indexOf('{{') : undefined,
        tokenizer(src: string) {
          const m = /^\{\{[^{}\n]{1,200}\}\}/.exec(src)
          return m ? { type: 'templateVariable', raw: m[0], text: m[0] } : undefined
        },
        renderer: (token) => `<span class="md-var" title="Variable (not resolved in docs)">${esc(String(token.text))}</span>`,
      },
    ],
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens)
        const base = slugify(plainText(tokens))
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const slug = n === 0 ? base : `${base}-${n}`
        return `<h${depth} data-anchor="${esc(slug)}">${inner}<a class="md-anchor" href="#${esc(slug)}" aria-label="Link to this section">#</a></h${depth}>\n`
      },
      code({ text, lang }: Tokens.Code) {
        const language = fenceLanguage(lang)
        const label = language ? `<span class="md-code-lang" aria-hidden="true">${esc(language)}</span>` : ''
        return `<pre class="md-code">${label}<code>${highlightToHtml(text, language)}</code></pre>\n`
      },
      codespan({ text }: Tokens.Codespan) {
        return `<code>${withVars(text)}</code>`
      },
    },
  })
  return { marked, resetSlugs: () => seen.clear() }
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul', 'var',
]
const ALLOWED_ATTR = [
  'href', 'title', 'alt', 'src', 'align', 'colspan', 'rowspan', 'start', 'reversed', 'type', 'checked', 'disabled',
  'class', 'open', 'width', 'height', 'data-anchor', 'aria-label', 'aria-hidden',
]
/** http(s), mailto, #fragment, or a relative reference (no scheme). */
const ALLOWED_URI = /^(?:(?:https?|mailto):|#|[^a-z]|[a-z0-9+.-]+(?:[^a-z0-9+.\-:]|$))/i
const SAFE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|svg\+xml)[;,]/i
const OWN_CLASS = /^(?:md-[a-z-]+|tok-[a-z]+)$/
export const EXTERNAL_URL = /^(?:https?:|mailto:)/i

let purifier: ReturnType<typeof DOMPurify> | null = null
function purify() {
  if (purifier) return purifier
  const p = DOMPurify(window)
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'class') {
      data.attrValue = data.attrValue.split(/\s+/).filter((c) => OWN_CLASS.test(c)).join(' ')
      if (!data.attrValue) data.keepAttr = false
    }
  })
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'A') {
      const href = el.getAttribute('href')
      if (href && EXTERNAL_URL.test(href.trim())) {
        el.setAttribute('class', 'md-ext')
        el.setAttribute('title', el.getAttribute('title') || href)
      }
    } else if (el.tagName === 'IMG') {
      const src = (el.getAttribute('src') ?? '').trim()
      if (!SAFE_IMAGE.test(src)) {
        el.removeAttribute('src')
        el.setAttribute('class', 'md-img-blocked')
        // Keep an http(s) URL only as the target of an "Open image" link (built after sanitising).
        if (/^https?:/i.test(src)) el.setAttribute('title', src)
        else el.removeAttribute('title')
      }
    } else if (el.tagName === 'INPUT') {
      // Only GFM task-list checkboxes, never editable (any other input type is turned into one).
      el.setAttribute('type', 'checkbox')
      el.setAttribute('disabled', '')
    }
  })
  purifier = p
  return p
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: true,
} as const

/** Sanitises an HTML string with the docs policy and returns a detached fragment. */
export function sanitizeFragment(dirty: string): DocumentFragment {
  const frag = purify().sanitize(dirty, PURIFY_CONFIG) as unknown as DocumentFragment
  postProcess(frag)
  return frag
}

/** Sanitised HTML string (what the view injects). */
export function sanitizeHtml(dirty: string): string {
  const box = document.createElement('div')
  box.append(sanitizeFragment(dirty))
  return box.innerHTML
}

/**
 * After sanitising (DOM APIs only, text via textContent): blocked images become placeholders and
 * `{{variables}}` in prose text nodes become highlighted tokens.
 */
function postProcess(root: DocumentFragment) {
  for (const img of Array.from(root.querySelectorAll('img.md-img-blocked'))) {
    const url = img.getAttribute('title')
    const box = document.createElement('span')
    box.className = 'md-img-blocked'
    const label = document.createElement('span')
    label.className = 'md-img-label'
    label.textContent = img.getAttribute('alt') || 'Image'
    box.append(label)
    if (url && /^https?:/i.test(url)) {
      const a = document.createElement('a')
      a.className = 'md-ext'
      a.setAttribute('href', url)
      a.setAttribute('title', url)
      a.textContent = 'Open image'
      box.append(' ', a)
    }
    box.setAttribute('title', 'Remote images are not loaded in documentation')
    img.replaceWith(box)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const hits: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    const parent = text.parentElement
    if (!parent || parent.closest('code, pre, .md-var')) continue
    if (text.data.includes('{{')) hits.push(text)
  }
  for (const text of hits) {
    const parts = text.data.split(/(\{\{[^{}\n]{1,200}\}\})/)
    if (parts.length === 1) continue
    const frag = document.createDocumentFragment()
    parts.forEach((part, i) => {
      if (!part) return
      if (i % 2 === 1) {
        const span = document.createElement('span')
        span.className = 'md-var'
        span.textContent = part
        frag.append(span)
      } else frag.append(part)
    })
    text.replaceWith(frag)
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

let engine: ReturnType<typeof createMarked> | null = null
const cache = new Map<string, string>()
const CACHE_SIZE = 32

/** Rendered, sanitised HTML for a description (Markdown, or plain text shown verbatim). */
export function renderDocs(source: string, format: DescriptionFormat = 'markdown'): string {
  const key = `${format}\u0000${source}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let dirty: string
  if (format === 'plain') {
    dirty = `<div class="md-plain">${esc(source)}</div>`
  } else {
    engine ??= createMarked()
    engine.resetSlugs()
    try {
      dirty = engine.marked.parse(source) as string
    } catch {
      dirty = `<div class="md-plain">${esc(source)}</div>`
    }
  }
  const out = sanitizeHtml(dirty)
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
  cache.set(key, out)
  return out
}
