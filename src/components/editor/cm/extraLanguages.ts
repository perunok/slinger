import { php } from '@codemirror/lang-php'
import { StreamLanguage } from '@codemirror/language'
import { go } from '@codemirror/legacy-modes/mode/go'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { python } from '@codemirror/legacy-modes/mode/python'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import type { Extension } from '@codemirror/state'
import type { EditorLanguage } from '../../../lib/editorLanguage'
import { httpFile } from './httpFile'

/**
 * The languages that are only needed for code snippets and some response bodies: loaded on first use (languages.ts
 * `loadLanguage`) so they stay out of the startup bundle. Stream languages are CodeMirror 5 modes (@codemirror/legacy-modes).
 */
export function extraLanguage(lang: EditorLanguage): Extension | null {
  switch (lang) {
    case 'php':
      return php()
    case 'shell':
      return StreamLanguage.define(shell)
    case 'python':
      return StreamLanguage.define(python)
    case 'go':
      return StreamLanguage.define(go)
    case 'powershell':
      return StreamLanguage.define(powerShell)
    case 'http':
      return StreamLanguage.define(httpFile)
    case 'yaml':
      return StreamLanguage.define(yaml)
    default:
      return null
  }
}
