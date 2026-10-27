import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import type { Extension } from '@codemirror/state'
import type { EditorLanguage } from '../../../lib/editorLanguage'

export type { EditorLanguage }

type Extra = typeof import('./extraLanguages')
let extra: Extra | null = null
let extraLoading: Promise<Extra> | null = null

/**
 * Syntax highlighting for a language (`text`: none). JSON, XML, HTML, CSS, JavaScript and Markdown are part of the main
 * bundle; the others (cURL/shell, Python, Go, PHP, PowerShell, .http, YAML) come from a chunk loaded on first use: until
 * `loadLanguage` has resolved once, this returns no highlighting for them.
 */
export function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case 'json':
      return json()
    case 'xml':
      return xml()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'javascript':
      return javascript()
    case 'markdown':
      return markdown()
    case 'text':
      return []
    default:
      return extra?.extraLanguage(lang) ?? []
  }
}

/** Whether `lang` needs the lazily loaded chunk that is not loaded yet. */
export function needsLoading(lang: EditorLanguage): boolean {
  return !extra && !['json', 'xml', 'html', 'css', 'javascript', 'markdown', 'text'].includes(lang)
}

/** `languageExtension`, after loading the extra languages' chunk when `lang` is one of them. */
export async function loadLanguage(lang: EditorLanguage): Promise<Extension> {
  if (needsLoading(lang)) {
    extraLoading ??= import('./extraLanguages')
    extra = await extraLoading
  }
  return languageExtension(lang)
}
