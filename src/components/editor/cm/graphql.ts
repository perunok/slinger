import type { StreamParser, StringStream } from '@codemirror/language'

/**
 * GraphQL query documents (the GraphQL body's query editor). A small stream highlighter instead of `cm6-graphql`, which
 * pulls in `graphql` and `graphql-language-service` (much larger than this chunk); schema-aware completion is
 * lib/graphqlComplete.ts. Keywords, `$variables`, `@directives`, type names (after `on`, `type`... and capitalised
 * names), field names, strings, block strings, numbers and `#` comments. `{{variables}}` are marked by the template layer.
 */
interface State {
  /** Inside a `"""block string"""` that continues on the next line. */
  blockString: boolean
  /** The next name is a type (after `on`, `implements`, `type`, ...). */
  expectType: boolean
}

const KEYWORDS = new Set([
  'query', 'mutation', 'subscription', 'fragment', 'on', 'type', 'interface', 'union', 'enum', 'input', 'scalar', 'schema',
  'extend', 'implements', 'directive', 'repeatable',
])
const TYPE_KEYWORDS = new Set(['on', 'type', 'interface', 'union', 'enum', 'input', 'scalar', 'implements', 'extend'])
const ATOMS = new Set(['true', 'false', 'null'])

function blockString(stream: StringStream, state: State): string {
  while (!stream.eol()) {
    if (stream.match('"""')) {
      state.blockString = false
      return 'string'
    }
    if (!stream.match('\\"""')) stream.next()
  }
  return 'string'
}

export const graphqlLanguage: StreamParser<State> = {
  name: 'graphql',
  startState: () => ({ blockString: false, expectType: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.blockString) return blockString(stream, state)
    if (stream.eatSpace()) return null
    if (stream.match('{{')) {
      if (!stream.skipTo('}}')) stream.skipToEnd()
      else stream.match('}}')
      return 'variableName.special'
    }
    const ch = stream.peek()
    if (ch === '#') {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('"""')) {
      state.blockString = true
      return blockString(stream, state)
    }
    if (ch === '"') {
      stream.next()
      let escaped = false
      while (!stream.eol()) {
        const c = stream.next()
        if (c === '"' && !escaped) break
        escaped = !escaped && c === '\\'
      }
      return 'string'
    }
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^\$[_A-Za-z][_0-9A-Za-z]*/)) return 'variableName'
    if (stream.match(/^@[_A-Za-z][_0-9A-Za-z]*/)) return 'meta'
    if (stream.match('...')) return 'punctuation'
    const name = stream.match(/^[_A-Za-z][_0-9A-Za-z]*/) as RegExpMatchArray | null
    if (name) {
      const word = name[0]
      if (state.expectType && !KEYWORDS.has(word)) {
        state.expectType = false
        return 'typeName'
      }
      if (KEYWORDS.has(word)) {
        state.expectType = TYPE_KEYWORDS.has(word)
        return 'keyword'
      }
      if (ATOMS.has(word)) return 'atom'
      // By convention enum values are ALL_CAPS and types Capitalised (the type after `:` of a variable or argument
      // definition included: an alias `a: b` makes `:` alone ambiguous).
      if (word !== 'ID' && /^[A-Z][A-Z0-9_]+$/.test(word)) return 'atom'
      if (/^[A-Z]/.test(word)) return 'typeName'
      return 'propertyName'
    }
    stream.next()
    if (ch === '!' || ch === '=' || ch === '|' || ch === '&') return 'operator'
    if (ch === ':') return 'punctuation'
    return ch && '{}()[]'.includes(ch) ? 'bracket' : null
  },
  languageData: {
    commentTokens: { line: '#' },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
}
