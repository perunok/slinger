<script lang="ts">
  /**
   * A form generated from a JSON Schema (an MCP tool's `inputSchema`) that edits JSON text. Each change rewrites the
   * text through lib/jsonSchemaForm.ts, so keys the schema does not describe, the key order and `{{variables}}`
   * survive. Strings are TemplateInputs; number and boolean fields also take a whole `{{variable}}` (written as a bare
   * token so it resolves to a number or boolean). Unions, maps and other shapes the form cannot show get a small JSON
   * editor. Descriptions and limits sit behind (i) InfoTips.
   */
  import CodeEditor from '../editor/CodeEditor.svelte'
  import TemplateInput from '../editor/TemplateInput.svelte'
  import Button from './Button.svelte'
  import IconButton from './IconButton.svelte'
  import InfoTip from './InfoTip.svelte'
  import InlineError from './InlineError.svelte'
  import {
    displayText,
    effectiveKind,
    fieldProblem,
    getAt,
    newItemValue,
    parseArguments,
    parseJsonValue,
    placeholderFor,
    readText,
    schemaFields,
    setAt,
    stringifyArguments,
    stringifyJson,
    typeLabel,
    unknownKeys,
    type FieldKind,
    type SchemaField,
  } from '../../lib/jsonSchemaForm'

  interface Props {
    /** The JSON Schema of the value (an object schema). */
    schema: object
    /** The value as JSON text (may contain `{{variables}}`). */
    value: string
    onchange: (text: string) => void
    /** `{{variable}}` support (highlighting, completion, templates in number/boolean fields). Default on. */
    templates?: boolean
  }
  let { schema, value, onchange, templates = true }: Props = $props()

  const fields = $derived(schemaFields(schema))
  const parsed = $derived(parseArguments(value))
  const extra = $derived(parsed.ok ? unknownKeys(fields, parsed.value) : [])

  /**
   * What the user typed per input, shown while the stored value is still the one it produced: a number field keeps
   * "1.0" while typing "1.05" instead of jumping to "1", and a JSON editor keeps invalid text with its error.
   */
  let edits = $state<Record<string, { text: string; produced: string; error?: string }>>({})

  function commit(path: string[], v: unknown) {
    if (!parsed.ok) return
    onchange(stringifyArguments(setAt(parsed.value, fields, path, v)))
  }

  function shownText(key: string, current: unknown): string {
    const e = edits[key]
    return e && e.produced === stringifyJson(current) ? e.text : displayText(current)
  }
  function typeText(key: string, kind: FieldKind, text: string, apply: (v: unknown) => void) {
    const v = readText(kind, text, templates)
    edits[key] = { text, produced: stringifyJson(v) }
    apply(v)
  }

  function shownJson(key: string, current: unknown): { text: string; error?: string } {
    const e = edits[key]
    const cur = stringifyJson(current)
    return e && e.produced === cur ? e : { text: cur }
  }
  function typeJson(key: string, text: string, current: unknown, apply: (v: unknown) => void) {
    const r = parseJsonValue(text)
    if (r.ok) {
      edits[key] = { text, produced: stringifyJson(r.value) }
      apply(r.value)
    } else {
      edits[key] = { text, produced: stringifyJson(current), error: r.error }
    }
  }

  const BOOLEANS = ['true', 'false']
  const suggestBoolean = (t: string) => BOOLEANS.filter((b) => b !== t.trim() && b.startsWith(t.trim()))
  const labelOf = (field: SchemaField) => field.path.join('.')
  const optionText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
</script>

{#snippet head(field: SchemaField)}
  <span class="flex min-w-0 items-center gap-1.5 text-xs">
    <span class="truncate font-mono text-fg">{field.key}</span>
    {#if field.required}<span class="text-danger" title="Required" aria-hidden="true">*</span><span class="sr-only">(required)</span>{/if}
    <span class="text-faint">{typeLabel(field)}</span>
    {#if field.title || field.description || field.constraints.length}
      <InfoTip label="About {field.key}">
        {#if field.title}<strong>{field.title}</strong>{/if}
        {#if field.description}<span class="whitespace-pre-line">{field.description}</span>{/if}
        {#each field.constraints as c (c)}<span class="text-muted">{c}</span>{/each}
      </InfoTip>
    {/if}
  </span>
{/snippet}

<!-- One input for a primitive value: `f` gives the kind, enum values and placeholder. -->
{#snippet scalar(f: SchemaField, label: string, key: string, current: unknown, apply: (v: unknown) => void)}
  {@const problem = fieldProblem(f, current, templates)}
  {#if f.kind === 'enum' || (f.kind === 'boolean' && !templates)}
    {@const options = f.kind === 'enum' ? f.enumValues : [true, false]}
    {@const index = options.findIndex((o) => o === current)}
    <select
      class="w-full max-w-xs"
      aria-label={label}
      value={current === undefined ? '' : index >= 0 ? String(index) : 'current'}
      onchange={(e) => {
        const v = e.currentTarget.value
        apply(v === '' ? undefined : v === 'current' ? current : options[Number(v)])
      }}
    >
      <option value="">{f.hasDefault ? `Not set (default: ${optionText(f.default)})` : 'Not set'}</option>
      {#each options as o, i (i)}<option value={String(i)}>{optionText(o)}</option>{/each}
      {#if current !== undefined && index < 0}<option value="current">{displayText(current)}</option>{/if}
    </select>
  {:else if templates}
    <div class="min-w-0 flex-1 rounded border bg-surface px-1 py-0.5 focus-within:border-accent {problem ? 'border-danger' : 'border-border'}">
      <TemplateInput
        class="w-full !border-transparent"
        {label}
        mono={f.kind !== 'string'}
        value={shownText(key, current)}
        placeholder={placeholderFor(f, templates)}
        suggest={f.kind === 'boolean' ? suggestBoolean : undefined}
        oninput={(t) => typeText(key, f.kind, t, apply)}
      />
    </div>
  {:else}
    <input
      type="text"
      class="w-full {f.kind !== 'string' ? 'font-mono' : ''} {problem ? 'border-danger' : ''}"
      aria-label={label}
      value={shownText(key, current)}
      placeholder={placeholderFor(f, templates)}
      oninput={(e) => typeText(key, f.kind, e.currentTarget.value, apply)}
    />
  {/if}
  {#if problem}<span class="text-xs text-danger">{problem}</span>{/if}
{/snippet}

{#snippet jsonEditor(label: string, key: string, current: unknown, apply: (v: unknown) => void)}
  {@const shown = shownJson(key, current)}
  <div class="h-24 overflow-hidden rounded border {shown.error ? 'border-danger' : 'border-border'}">
    <CodeEditor value={shown.text} onchange={(t) => typeJson(key, t, current, apply)} language="json" lineNumbers={false} {templates} {label} placeholder="JSON value" />
  </div>
  {#if shown.error}<span class="text-xs text-danger">{shown.error}</span>{/if}
{/snippet}

{#snippet fieldView(field: SchemaField, current: unknown)}
  {@const kind = effectiveKind(field, current)}
  {@const label = labelOf(field)}
  {@const apply = (v: unknown) => commit(field.path, v)}
  {#if kind === 'object'}
    <fieldset class="grid gap-3 rounded border border-border px-3 pb-3 pt-1" data-field={label}>
      <legend class="px-1">{@render head(field)}</legend>
      {#each field.fields as child (child.key)}
        {@render fieldView(child, getAt(current, [child.key]))}
      {/each}
    </fieldset>
  {:else}
    <div class="grid gap-1" data-field={label}>
      {@render head(field)}
      {#if kind === 'array' && field.item}
        {@const item = field.item}
        {@const items = Array.isArray(current) ? current : []}
        {#each items as v, i (i)}
          <div class="flex items-start gap-1">
            <div class="grid min-w-0 flex-1 gap-1">
              {@render scalar(item, `${label} item ${i + 1}`, `t${JSON.stringify([...field.path, i])}`, v, (next) => apply(items.map((x, j) => (j === i ? (next ?? '') : x))))}
            </div>
            <IconButton icon="x" label="Remove {label} item {i + 1}" onclick={() => apply(items.filter((_, j) => j !== i))} />
          </div>
        {/each}
        <div><Button size="sm" variant="ghost" icon="plus" onclick={() => apply([...items, newItemValue(item)])}>Add item</Button></div>
      {:else if kind === 'json'}
        {@render jsonEditor(label, `j${JSON.stringify(field.path)}`, current, apply)}
      {:else}
        {@render scalar(field, label, `t${JSON.stringify(field.path)}`, current, apply)}
      {/if}
    </div>
  {/if}
{/snippet}

<div class="grid gap-3" data-testid="schema-form">
  {#if !parsed.ok}
    <InlineError message="{parsed.error} Fix it as JSON to use the form." />
  {:else if fields.length === 0}
    <p class="text-sm text-muted">No fields to fill in.</p>
  {:else}
    {#each fields as field (field.key)}
      {@render fieldView(field, getAt(parsed.value, [field.key]))}
    {/each}
  {/if}
  {#if extra.length}
    <p class="text-xs text-faint">
      Also sent, not described by the schema: {#each extra as k, i (k)}{i ? ', ' : ''}<code>{k}</code>{/each}. Edit them as JSON.
    </p>
  {/if}
</div>
