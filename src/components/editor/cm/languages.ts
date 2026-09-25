import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import type { Extension } from '@codemirror/state'

export type EditorLanguage = 'json' | 'xml' | 'html' | 'css' | 'javascript' | 'markdown' | 'text'

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
    default:
      return []
  }
}
