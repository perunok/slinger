/**
 * Schema-aware autocomplete for the GraphQL query editor. Pure: given the schema, the query text and the caret, it says
 * what fits there. A small tolerant scanner (not a full parser) walks the text before the caret and keeps a stack of
 * where it is: a selection set of some type, a field's or directive's arguments, an input object or list value, or an
 * operation's variable definitions. Unfinished documents (the normal case while typing) are fine.
 */
import type { GqlArg, GqlField, GqlSchema, GqlType } from './graphql'

export interface GqlCompletion {
  label: string
  /** CodeMirror completion type (icon): property, type, keyword, enum, variable. */
  type: 'property' | 'type' | 'keyword' | 'enum' | 'variable'
  /** Shown next to the label: the field's or argument's type. */
  detail?: string
  /** Description from the schema. */
  info?: string
}

export interface GqlCompletionResult {
  /** Where the word being completed starts. */
  from: number
  options: GqlCompletion[]
}

type Frame =
  | { kind: 'selection'; type: GqlType | null }
  | { kind: 'args'; args: GqlArg[]; argName: string | null; expectValue: boolean }
  | { kind: 'object'; type: GqlType | null; fieldName: string | null; expectValue: boolean }
  | { kind: 'list'; typeName: string }
  | { kind: 'varDefs'; expectType: boolean }

interface Token {
  /** 'name', 'punct' (one of {}()[]:=@!$|&), 'spread' (...), 'value' (string or number), 'template' ({{x}}). */
  t: 'name' | 'punct' | 'spread' | 'value' | 'template'
  v: string
}

/** Tokens of `text`; `open` says whether it ends inside a string, block string or comment (nothing to complete there). */
export function tokenize(text: string): { tokens: Token[]; open: boolean } {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '#') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) return { tokens, open: true }
      i = nl + 1
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3)
      if (end < 0) return { tokens, open: true }
      tokens.push({ t: 'value', v: '""' })
      i = end + 3
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      // A string ends at its line (GraphQL strings are single-line); one still open at the caret is being typed.
      if (j >= text.length) return { tokens, open: true }
      tokens.push({ t: 'value', v: '""' })
      i = j + 1
    } else if (text.startsWith('{{', i)) {
      const end = text.indexOf('}}', i + 2)
      if (end < 0) return { tokens, open: true }
      tokens.push({ t: 'template', v: text.slice(i, end + 2) })
      i = end + 2
    } else if (text.startsWith('...', i)) {
      tokens.push({ t: 'spread', v: '...' })
      i += 3
    } else if (/[_A-Za-z]/.test(c)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i, i + 256))!
      tokens.push({ t: 'name', v: m[0] })
      i += m[0].length
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?[0-9][0-9.eE+-]*/.exec(text.slice(i, i + 64))
      const len = m ? m[0].length : 1
      tokens.push({ t: 'value', v: text.slice(i, i + len) })
      i += len
    } else if ('{}()[]:=@!$|&'.includes(c)) {
      tokens.push({ t: 'punct', v: c })
      i++
    } else i++ // whitespace, commas, anything else
  }
  return { tokens, open: false }
}

const unwrap = (schema: GqlSchema, name: string | null | undefined): GqlType | null => (name ? (schema.types[name] ?? null) : null)

function fieldOf(type: GqlType | null, name: string): GqlField | null {
  if (!type) return null
  return type.fields.find((f) => f.name === name) ?? null
}

interface State {
  stack: Frame[]
  /** The tokens just before the caret, most recent last (for `on`, `@`, `$`, `...`). */
  prev: Token[]
}

/** Walks the tokens and returns where the caret is. */
function scan(schema: GqlSchema, tokens: Token[]): State {
  const stack: Frame[] = []
  const top = () => stack[stack.length - 1]
  // Top level: the root type of the next `{`, and whether `(` opens variable definitions.
  let pendingRoot: string | null = null
  // Within a selection: the last field named (for its `(` and `{`), an inline fragment's type, a directive's arguments.
  let lastField: GqlField | null = null
  let pendingInline: GqlType | null = null
  let afterSpread = false
  let afterOn = false
  let afterAt = false
  let directiveArgs: GqlArg[] | null = null
  let topKeyword: string | null = null
  const valueDone = () => {
    const f = top()
    if (f && (f.kind === 'args' || f.kind === 'object')) f.expectValue = false
  }

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]
    const f = top()
    if (!f) {
      // Top level: `query Name(...) {`, `fragment F on T {`, or a bare `{`.
      if (tok.t === 'name') {
        if (tok.v === 'query') pendingRoot = schema.queryType
        else if (tok.v === 'mutation') pendingRoot = schema.mutationType
        else if (tok.v === 'subscription') pendingRoot = schema.subscriptionType
        else if (topKeyword === 'on') pendingRoot = tok.v
        topKeyword = tok.v === 'fragment' || tok.v === 'on' ? tok.v : topKeyword === 'fragment' ? 'fragmentName' : null
      } else if (tok.v === '(') stack.push({ kind: 'varDefs', expectType: false })
      else if (tok.v === '{') {
        stack.push({ kind: 'selection', type: unwrap(schema, pendingRoot ?? schema.queryType) })
        pendingRoot = null
        topKeyword = null
      }
      continue
    }
    switch (f.kind) {
      case 'varDefs':
        if (tok.v === ')') stack.pop()
        else if (tok.v === ':') f.expectType = true
        // After `:` the type follows (also inside `[` / after `!`), until the next `$variable` or `= default`.
        else if (tok.v === '$' || tok.v === '=') f.expectType = false
        break
      case 'selection':
        if (tok.t === 'spread') {
          afterSpread = true
        } else if (tok.t === 'name') {
          if (afterAt) {
            directiveArgs = schema.directives.find((d) => d.name === tok.v)?.args ?? []
            afterAt = false
          } else if (afterSpread && tok.v === 'on') {
            afterOn = true
          } else if (afterOn) {
            pendingInline = unwrap(schema, tok.v)
            afterOn = false
            afterSpread = false
          } else if (afterSpread) {
            afterSpread = false // a fragment spread `...Name`
          } else {
            lastField = fieldOf(f.type, tok.v)
            directiveArgs = null
          }
        } else if (tok.v === '@') {
          afterAt = true
        } else if (tok.v === '(') {
          stack.push({ kind: 'args', args: directiveArgs ?? lastField?.args ?? [], argName: null, expectValue: false })
          directiveArgs = null
        } else if (tok.v === '{') {
          const next = afterSpread ? f.type : pendingInline ?? (lastField ? unwrap(schema, lastField.typeName) : null)
          stack.push({ kind: 'selection', type: next })
          lastField = null
          pendingInline = null
          afterSpread = false
          directiveArgs = null
        } else if (tok.v === '}') {
          stack.pop()
          lastField = null
          pendingInline = null
          afterSpread = false
        }
        break
      case 'args':
      case 'object': {
        const close = f.kind === 'args' ? ')' : '}'
        if (tok.v === close) {
          stack.pop()
          valueDone()
        } else if (tok.v === ':') f.expectValue = true
        else if (f.expectValue) {
          const argType = f.kind === 'args' ? f.args.find((a) => a.name === f.argName)?.typeName : fieldOf(f.type, f.fieldName ?? '')?.typeName
          if (tok.v === '{') stack.push({ kind: 'object', type: unwrap(schema, argType), fieldName: null, expectValue: false })
          else if (tok.v === '[') stack.push({ kind: 'list', typeName: argType ?? '' })
          else if (tok.v === '$') {
            /* a variable: its name follows */
          } else f.expectValue = false
        } else if (tok.t === 'name') {
          if (f.kind === 'args') f.argName = tok.v
          else f.fieldName = tok.v
        }
        break
      }
      case 'list':
        if (tok.v === ']') {
          stack.pop()
          valueDone()
        } else if (tok.v === '{') stack.push({ kind: 'object', type: unwrap(schema, f.typeName), fieldName: null, expectValue: false })
        else if (tok.v === '[') stack.push({ kind: 'list', typeName: f.typeName })
        break
    }
  }
  return { stack, prev: tokens.slice(-3) }
}

const fieldOption = (f: GqlField): GqlCompletion => ({
  label: f.name,
  type: 'property',
  detail: f.args.length > 0 ? `(${f.args.map((a) => a.name).join(', ')}): ${f.type}` : f.type,
  ...(f.description || f.deprecated ? { info: [f.description, f.deprecated ? `Deprecated: ${f.deprecated}` : ''].filter(Boolean).join('\n\n') } : {}),
})

const argOption = (a: GqlArg): GqlCompletion => ({ label: a.name, type: 'property', detail: a.type, ...(a.description ? { info: a.description } : {}) })

const typeOption = (t: GqlType): GqlCompletion => ({ label: t.name, type: 'type', detail: t.kind.toLowerCase().replace('_', ' '), ...(t.description ? { info: t.description } : {}) })

function valueOptions(schema: GqlSchema, typeName: string | undefined): GqlCompletion[] {
  const t = unwrap(schema, typeName)
  if (!t) return []
  if (t.kind === 'ENUM') return t.enumValues.map((e) => ({ label: e.name, type: 'enum' as const, detail: t.name, ...(e.description ? { info: e.description } : {}) }))
  if (t.name === 'Boolean') return ['true', 'false'].map((label) => ({ label, type: 'keyword' as const }))
  return []
}

const TOP_KEYWORDS = ['query', 'mutation', 'subscription', 'fragment']

/** What can be typed at `pos` in `text`, or null when nothing (inside a string, comment or `{{template}}`, or no idea). */
export function graphqlCompletions(schema: GqlSchema, text: string, pos: number): GqlCompletionResult | null {
  const before = text.slice(0, pos)
  const word = /[_A-Za-z][_0-9A-Za-z]*$/.exec(before)?.[0] ?? ''
  const from = pos - word.length
  const { tokens, open } = tokenize(before.slice(0, from))
  if (open) return null
  const { stack, prev } = scan(schema, tokens)
  const last = prev[prev.length - 1]
  const f = stack[stack.length - 1]
  if (last?.v === '$') return null // a variable name
  if (!f) {
    // `on` of a fragment definition takes a type; otherwise the operation keywords.
    if (last?.t === 'name' && last.v === 'on') return { from, options: schemaTypes(schema, ['OBJECT', 'INTERFACE', 'UNION']) }
    if (last && last.t === 'name' && TOP_KEYWORDS.includes(last.v)) return null // naming the operation
    return { from, options: TOP_KEYWORDS.map((label) => ({ label, type: 'keyword' })) }
  }
  switch (f.kind) {
    case 'selection': {
      if (last?.v === '@') return { from, options: schema.directives.map((d) => ({ label: d.name, type: 'keyword', ...(d.description ? { info: d.description } : {}) })) }
      if (last?.t === 'name' && last.v === 'on' && prev[prev.length - 2]?.t === 'spread') {
        return { from, options: schemaTypes(schema, ['OBJECT', 'INTERFACE', 'UNION']) }
      }
      if (last?.t === 'spread') return { from, options: [{ label: 'on', type: 'keyword' }] }
      if (!f.type) return null
      const options: GqlCompletion[] = f.type.kind === 'UNION' ? [] : f.type.fields.map(fieldOption)
      options.push({ label: '__typename', type: 'property', detail: 'String!' })
      return { from, options }
    }
    case 'args':
      if (f.expectValue) return { from, options: valueOptions(schema, f.args.find((a) => a.name === f.argName)?.typeName) }
      return { from, options: f.args.map(argOption) }
    case 'object':
      if (f.expectValue) return { from, options: valueOptions(schema, fieldOf(f.type, f.fieldName ?? '')?.typeName) }
      return { from, options: f.type ? f.type.fields.map(argOption) : [] }
    case 'list':
      return { from, options: valueOptions(schema, f.typeName) }
    case 'varDefs':
      if (!f.expectType) return null
      return { from, options: schemaTypes(schema, ['SCALAR', 'ENUM', 'INPUT_OBJECT']) }
  }
}

function schemaTypes(schema: GqlSchema, kinds: GqlType['kind'][]): GqlCompletion[] {
  return Object.values(schema.types)
    .filter((t) => kinds.includes(t.kind) && !t.name.startsWith('__'))
    .map(typeOption)
}
