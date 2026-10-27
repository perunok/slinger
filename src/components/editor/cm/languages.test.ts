import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { beforeAll, describe, expect, it } from 'vitest'
import type { EditorLanguage } from '../../../lib/editorLanguage'
import { languageExtension, loadLanguage, needsLoading } from './languages'

// One snippet per language, each with a string the highlighter must mark.
const SAMPLES: Record<Exclude<EditorLanguage, 'text'>, string> = {
  json: '{"a": "x"}',
  xml: '<a b="x"/>',
  html: '<p class="x">hi</p>',
  css: 'a { content: "x"; }',
  javascript: 'const a = "x"',
  markdown: '# Title\n\n`code` and "x"',
  yaml: 'a: "x"',
  shell: `curl --location --request POST 'https://api.example.com/x' \\\n  --header 'Content-Type: application/json'`,
  python: 'import requests\nr = requests.get("https://x")',
  go: 'package main\nfunc main() { s := "x" }',
  php: '<?php\n$ch = curl_init("https://x");',
  powershell: '$r = Invoke-RestMethod -Uri "https://x" -Method Get',
  http: '### Get one\nGET https://x/items/1\nAccept: application/json',
}

/** The style classes the highlighter gives the sample, in order. */
function classes(lang: EditorLanguage, doc: string): string[] {
  const state = EditorState.create({ doc, extensions: languageExtension(lang) })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  const out: string[] = []
  if (!tree) return out
  const highlighter = tagHighlighter([
    { tag: tags.string, class: 'string' },
    { tag: tags.keyword, class: 'keyword' },
    { tag: [tags.variableName, tags.propertyName, tags.attributeName, tags.tagName, tags.atom, tags.heading], class: 'name' },
  ])
  highlightTree(tree, highlighter, (_from, _to, cls) => out.push(cls))
  return out
}

beforeAll(async () => {
  expect(needsLoading('shell')).toBe(true) // not in the startup bundle
  await loadLanguage('shell')
  expect(needsLoading('shell')).toBe(false)
})

describe('languageExtension', () => {
  it('plain text has no highlighting', () => {
    expect(languageExtension('text')).toEqual([])
  })

  it.each(Object.entries(SAMPLES) as [EditorLanguage, string][])('%s is highlighted', (lang, sample) => {
    const found = classes(lang, sample)
    expect(found.length, `no highlighted tokens for ${lang}`).toBeGreaterThan(0)
  })

  it('a cURL command marks its quoted arguments as strings', () => {
    expect(classes('shell', SAMPLES.shell)).toContain('string')
  })
})

/** Each highlighted token of `doc` with the tag name it got ("text:tag"). */
function tokens(lang: EditorLanguage, doc: string): string[] {
  const state = EditorState.create({ doc, extensions: languageExtension(lang) })
  const tree = ensureSyntaxTree(state, doc.length, 5000)!
  const highlighter = tagHighlighter([
    { tag: tags.comment, class: 'comment' },
    { tag: tags.keyword, class: 'keyword' },
    { tag: tags.url, class: 'url' },
    { tag: tags.propertyName, class: 'property' },
    { tag: tags.string, class: 'string' },
    { tag: tags.number, class: 'number' },
    { tag: tags.atom, class: 'atom' },
    { tag: tags.meta, class: 'meta' },
    { tag: tags.special(tags.variableName), class: 'variable' },
    { tag: tags.definition(tags.variableName), class: 'definition' },
  ])
  const out: string[] = []
  highlightTree(tree, highlighter, (from, to, cls) => out.push(`${doc.slice(from, to).trim()}:${cls}`))
  return out
}

describe('.http files', () => {
  it('marks separators, request lines, headers, variables and the JSON body', () => {
    const doc = [
      '@host = https://api.example.com',
      '',
      '### Create a user',
      'POST {{host}}/users HTTP/1.1',
      'Content-Type: application/json',
      'Authorization: Bearer {{token}}',
      '',
      '{"name": "Ada", "age": 36, "admin": false}',
      '',
      '###',
      '# a comment',
      'GET https://api.example.com/users',
    ].join('\n')
    const found = tokens('http', doc)
    expect(found).toEqual(
      expect.arrayContaining([
        '@host:definition',
        '### Create a user:comment',
        'POST:keyword',
        '{{host}}:variable',
        '/users:url',
        'HTTP/1.1:meta',
        'Content-Type:property',
        'application/json:string',
        '{{token}}:variable',
        '"name":property',
        '"Ada":string',
        '36:number',
        'false:atom',
        '###:comment',
        '# a comment:comment',
        'GET:keyword',
        'https://api.example.com/users:url',
      ]),
    )
    // The second request's line is a request again, not a header.
    expect(found).not.toContain('GET https:property')
  })
})
