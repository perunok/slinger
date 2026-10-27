import type { StreamParser, StringStream } from '@codemirror/language'

/**
 * `.http` request files (REST Client / JetBrains HTTP Client; what Slinger's ".http" snippet and export write). CodeMirror 5's
 * `http` mode reads a single raw HTTP message, not this format: `###` separators and `#` / `//` comments, `@name = value`
 * file variables, a request line per request, headers, a blank line, then the body. `{{variables}}` are marked anywhere.
 */
interface State {
  /** Where the next line belongs. */
  section: 'request' | 'headers' | 'body'
  /** Inside a header line, after its name. */
  headerValue: boolean
}

const METHODS = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/

function variable(stream: StringStream): boolean {
  if (!stream.match('{{')) return false
  if (!stream.skipTo('}}')) stream.skipToEnd()
  else stream.match('}}')
  return true
}

/** Plain text up to the next `{{` (or the end of the line). */
function upToVariable(stream: StringStream): void {
  while (!stream.eol() && !stream.match('{{', false)) stream.next()
}

export const httpFile: StreamParser<State> = {
  name: 'http',
  startState: () => ({ section: 'request', headerValue: false }),
  copyState: (s) => ({ ...s }),
  blankLine(state) {
    // The blank line after the headers starts the body; blank lines before a request line change nothing.
    if (state.section === 'headers') state.section = 'body'
  },
  token(stream, state) {
    if (stream.sol()) {
      state.headerValue = false
      // `###` starts the next request (anything after it on the line names it).
      if (stream.match(/^###/)) {
        stream.skipToEnd()
        state.section = 'request'
        return 'comment'
      }
      if (state.section !== 'body' && stream.match(/^\s*(?:#|\/\/)/)) {
        stream.skipToEnd()
        return 'comment'
      }
      if (state.section === 'request' && stream.match(/^@[\w.-]+/)) return 'variableName.definition'
    }
    if (variable(stream)) return 'variableName.special'

    if (state.section === 'request') {
      if (stream.eatSpace()) return null
      if (stream.sol() || stream.string.slice(0, stream.pos).trim() === '') {
        if (stream.match(METHODS)) return 'keyword'
      }
      if (stream.match(/^=/)) return 'operator'
      if (stream.match(/^HTTP\/[\d.]+/)) {
        state.section = 'headers'
        return 'meta'
      }
      // The URL (or a file variable's value), up to the next {{variable}} or HTTP/x.
      while (!stream.eol() && !stream.match('{{', false) && !stream.match(/^\s+HTTP\//, false)) stream.next()
      if (stream.eol() && /^\s*(?:[A-Z]+\s|https?:\/\/|\/)/.test(stream.string)) state.section = 'headers'
      return /^\s*@/.test(stream.string) ? 'string' : 'url'
    }

    if (state.section === 'headers') {
      if (!state.headerValue) {
        if (stream.match(/^[^:\s{]+(?=\s*:)/)) return 'propertyName'
        if (stream.match(/^\s*:\s*/)) {
          state.headerValue = true
          return 'punctuation'
        }
      }
      upToVariable(stream)
      return 'string'
    }

    // Body: JSON-ish highlighting, which also reads well for form and plain text bodies.
    if (stream.eatSpace()) return null
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return stream.match(/^\s*:/, false) ? 'propertyName' : 'string'
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^(?:true|false|null)\b/)) return 'atom'
    if (stream.match(/^[{}[\],:]/)) return 'punctuation'
    stream.next()
    while (!stream.eol() && !/[\s"{}[\],:]/.test(stream.peek() ?? '')) stream.next()
    return null
  },
  languageData: { commentTokens: { line: '#' } },
}
