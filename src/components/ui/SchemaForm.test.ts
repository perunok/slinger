import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SchemaForm from './SchemaForm.svelte'

afterEach(cleanup)

const schema = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'City name' },
    units: { type: 'string', enum: ['metric', 'imperial'], default: 'metric' },
    days: { type: 'integer', minimum: 1 },
    detailed: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    address: { type: 'object', properties: { street: { type: 'string' }, zip: { type: 'string' } }, required: ['zip'] },
    either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
  required: ['city'],
}

/** Renders a controlled form: every onchange is fed back as the new value, like the request editor does. */
function setup(value: string, props: Record<string, unknown> = {}) {
  const changes: string[] = []
  const onchange = vi.fn((text: string) => {
    changes.push(text)
    void result.rerender({ value: text })
  })
  const result = render(SchemaForm, { schema, value, onchange, ...props })
  return { ...result, onchange, changes }
}

const viewOf = (name: string) => EditorView.findFromDOM(screen.getByRole('textbox', { name }).closest('.cm-editor') as HTMLElement)!
async function typeInto(name: string, text: string) {
  const view = viewOf(name)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  await tick()
}

describe('SchemaForm', () => {
  it('shows a field per property with type, required marker and an InfoTip for the description', () => {
    setup('{}')
    const city = screen.getByRole('textbox', { name: 'city' })
    expect(city).toBeInTheDocument()
    const cityRow = city.closest('[data-field="city"]') as HTMLElement
    expect(cityRow).toHaveTextContent(/^city\s*\*\s*\(required\)\s*string/)
    expect(within(cityRow).getByRole('button', { name: 'About city' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'units' })).toHaveDisplayValue('Not set (default: metric)')
    expect(screen.getByRole('textbox', { name: 'days' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /address/ })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'address.zip' })).toBeInTheDocument()
  })

  it('writes string edits into the JSON text, keeping unknown keys and key order', async () => {
    const { changes } = setup('{"zeta": 1, "days": 2}')
    await typeInto('city', 'Paris {{suffix}}')
    expect(changes.at(-1)).toBe('{\n  "zeta": 1,\n  "city": "Paris {{suffix}}",\n  "days": 2\n}')
    await typeInto('city', '')
    expect(changes.at(-1)).toBe('{\n  "zeta": 1,\n  "days": 2\n}')
  })

  it('stores numbers typed, keeps what is being typed, and writes a whole {{variable}} bare', async () => {
    const { changes } = setup('{}')
    await typeInto('days', '1.0')
    expect(changes.at(-1)).toBe('{\n  "days": 1\n}')
    expect(viewOf('days').state.doc.toString()).toBe('1.0')
    await typeInto('days', '2.5')
    expect(changes.at(-1)).toBe('{\n  "days": 2.5\n}')
    expect(screen.getByText('Enter a whole number or a {{variable}}.')).toBeInTheDocument()
    await typeInto('days', '3')
    expect(screen.queryByText(/Enter a whole number/)).toBeNull()
    await typeInto('days', '{{days}}')
    expect(changes.at(-1)).toBe('{\n  "days": {{days}}\n}')
    await typeInto('detailed', 'true')
    expect(changes.at(-1)).toBe('{\n  "days": {{days}},\n  "detailed": true\n}')
  })

  it('shows a stored bare token in a number field and keeps unparsable text with a hint', () => {
    setup('{"days": {{n}}, "detailed": "maybe"}')
    expect(viewOf('days').state.doc.toString()).toBe('{{n}}')
    expect(viewOf('detailed').state.doc.toString()).toBe('maybe')
    expect(screen.getByText('Enter true or false or a {{variable}}.')).toBeInTheDocument()
  })

  it('picks enum values from a select; Not set removes the key; an unknown stored value stays selectable', async () => {
    const { changes } = setup('{"units": "kelvin"}')
    const select = screen.getByRole('combobox', { name: 'units' })
    expect(select).toHaveDisplayValue('kelvin')
    expect(screen.getByText('Not one of the allowed values.')).toBeInTheDocument()
    await fireEvent.change(select, { target: { value: '1' } })
    expect(changes.at(-1)).toBe('{\n  "units": "imperial"\n}')
    expect(select).toHaveDisplayValue('imperial')
    await fireEvent.change(select, { target: { value: '' } })
    expect(changes.at(-1)).toBe('{}')
  })

  it('edits arrays of primitives as rows', async () => {
    const { changes } = setup('{"tags": ["a"]}')
    await fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    expect(changes.at(-1)).toBe('{\n  "tags": [\n    "a",\n    ""\n  ]\n}')
    await typeInto('tags item 2', 'b')
    expect(JSON.parse(changes.at(-1)!)).toEqual({ tags: ['a', 'b'] })
    await fireEvent.click(screen.getByRole('button', { name: 'Remove tags item 1' }))
    expect(JSON.parse(changes.at(-1)!)).toEqual({ tags: ['b'] })
  })

  it('creates a nested object when one of its fields is filled', async () => {
    const { changes } = setup('{"city": "x"}')
    await typeInto('address.zip', '1000')
    expect(JSON.parse(changes.at(-1)!)).toEqual({ city: 'x', address: { zip: '1000' } })
  })

  it('edits unions as JSON: valid text is written, invalid text shows the error and is not', async () => {
    const { onchange, changes } = setup('{"either": 5}')
    expect(viewOf('either').state.doc.toString()).toBe('5')
    await typeInto('either', '"five"')
    expect(changes.at(-1)).toBe('{\n  "either": "five"\n}')
    const calls = onchange.mock.calls.length
    await typeInto('either', '"fiv')
    expect(onchange.mock.calls.length).toBe(calls)
    expect(viewOf('either').state.doc.toString()).toBe('"fiv')
    expect(screen.getByRole('textbox', { name: 'either' }).closest('[data-field]')).toHaveTextContent(/JSON/)
  })

  it('edits a value of an unexpected type as JSON instead of coercing it', () => {
    setup('{"city": 42}')
    expect(viewOf('city').state.doc.toString()).toBe('42')
    expect(screen.getByRole('textbox', { name: 'city' }).getAttribute('aria-multiline')).not.toBe('false')
  })

  it('names keys the schema does not describe', () => {
    setup('{"zeta": 1, "city": "x", "other": true}')
    expect(screen.getByText(/Also sent, not described by the schema/)).toHaveTextContent('zeta, other')
  })

  it('shows an error and no fields when the text is not a JSON object', () => {
    setup('{"city": ')
    expect(screen.getByRole('alert')).toHaveTextContent('The arguments are not valid JSON')
    expect(screen.queryByRole('textbox', { name: 'city' })).toBeNull()
  })

  it('says so when the schema has no fields', () => {
    render(SchemaForm, { schema: { type: 'object' }, value: '{}', onchange: vi.fn() })
    expect(screen.getByText('No fields to fill in.')).toBeInTheDocument()
  })

  it('without templates uses plain inputs and a select for booleans', async () => {
    const { changes } = setup('{}', { templates: false })
    const days = screen.getByRole('textbox', { name: 'days' })
    expect(days.tagName).toBe('INPUT')
    await fireEvent.input(days, { target: { value: '{{n}}' } })
    expect(changes.at(-1)).toBe('{\n  "days": "{{n}}"\n}')
    expect(screen.getByText('Enter a whole number.')).toBeInTheDocument()
    await fireEvent.change(screen.getByRole('combobox', { name: 'detailed' }), { target: { value: '1' } })
    expect(JSON.parse(changes.at(-1)!)).toEqual({ days: '{{n}}', detailed: false })
  })
})
