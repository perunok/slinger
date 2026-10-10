<script lang="ts" module>
  import type { McpListKind } from '../../../shared/types'

  /** What the server listed (null until connected); each list holds every page, at most 1000 items. */
  export interface McpLists {
    tools: Array<Record<string, unknown>>
    resources: Array<Record<string, unknown>>
    resourceTemplates: Array<Record<string, unknown>>
    prompts: Array<Record<string, unknown>>
    /** Lists cut at 1000 items. */
    truncated: Partial<Record<McpListKind, boolean>>
  }

  // --- URI templates (RFC 6570, the parts MCP servers use) --------------------------------------------------------

  const EXPR = /\{([+#./;?&]?)([^}]*)\}/g

  /** Variable names of a URI template, in order (`demo://users/{id}{?fields}` -> ['id', 'fields']). */
  export function templateVars(template: string): string[] {
    const out: string[] = []
    for (const m of template.matchAll(EXPR)) {
      for (const raw of m[2].split(',')) {
        const name = raw.trim().replace(/\*$|:\d+$/, '')
        if (name && !out.includes(name)) out.push(name)
      }
    }
    return out
  }

  /**
   * Fills a URI template. Values are inserted as typed (they may hold `{{variables}}`, resolved when the request runs);
   * empty values drop out of query-style expressions.
   */
  export function expandTemplate(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(EXPR, (_, op: string, list: string) => {
      const names = list.split(',').map((n) => n.trim().replace(/\*$|:\d+$/, '')).filter(Boolean)
      if (op === '?' || op === '&') {
        const pairs = names.filter((n) => (values[n] ?? '') !== '').map((n) => `${n}=${values[n]}`)
        return pairs.length ? (op + pairs.join('&')).replace(/^&/, op === '?' ? '?' : '&') : ''
      }
      if (op === ';') return names.map((n) => `;${n}${values[n] ? `=${values[n]}` : ''}`).join('')
      const parts = names.map((n) => values[n] ?? '')
      const prefix = op === '#' ? '#' : op === '.' ? '.' : op === '/' ? '/' : ''
      return prefix + parts.join(op === '/' ? '/' : op === '.' ? '.' : ',')
    })
  }

  /**
   * The values a URI was filled with, or null when it does not fit the template. Only simple (`{x}`) and reserved
   * (`{+x}`) single-variable expressions take part; a template with anything else never matches.
   */
  export function matchTemplate(template: string, uri: string): Record<string, string> | null {
    const names: string[] = []
    let pattern = '^'
    let last = 0
    for (const m of template.matchAll(EXPR)) {
      const name = m[2].trim()
      if ((m[1] !== '' && m[1] !== '+') || !/^[\w.%-]+$/.test(name)) return null
      pattern += escapeRegExp(template.slice(last, m.index)) + (m[1] === '+' ? '(.*?)' : '([^/?#]*?)')
      names.push(name)
      last = m.index! + m[0].length
    }
    pattern += escapeRegExp(template.slice(last)) + '$'
    const found = new RegExp(pattern).exec(uri)
    if (!found) return null
    return Object.fromEntries(names.map((n, i) => [n, found[i + 1]]))
  }

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * Arguments when another tool is selected: kept as they are (clicking a tool only to read its description must not
   * lose what was typed); empty text becomes `{}`.
   */
  export function argumentsForTool(text: string): string {
    return text.trim() === '' ? '{}' : text
  }
</script>

<script lang="ts">
  /**
   * The Call section of an MCP request: what the server offers (tools, resources, resource templates, prompts) on the
   * left, and the selected operation with its form on the right. Selecting an item writes the operation and its
   * target into the request; the form edits the arguments, URI or prompt arguments.
   */
  import { untrack } from 'svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import SchemaForm from '../../components/ui/SchemaForm.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { dataRows, ensureTrailingEmpty, newRow } from '../../lib/kv'
  import type { McpDraft, McpOperation } from '../../lib/mcpRequest'
  import type { RequestTab } from '../requests/tabs.svelte'

  interface Props {
    tab: RequestTab
    lists: McpLists | null
    /** The lists are being (re)loaded. */
    loading?: boolean
    /** Why loading the lists failed, if it did. */
    listError?: string | null
    onrefresh?: () => void
  }
  let { tab, lists, loading = false, listError = null, onrefresh }: Props = $props()
  const mcp = $derived(tab.draft.mcp as McpDraft)

  type Item = Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

  const KIND_OF: Record<McpOperation, McpListKind> = { 'tools/call': 'tools', 'resources/read': 'resources', 'prompts/get': 'prompts' }
  const KIND_LABEL: Record<McpListKind, string> = { tools: 'Tools', resources: 'Resources', resourceTemplates: 'Templates', prompts: 'Prompts' }
  const OPERATIONS: { id: McpOperation; label: string }[] = [
    { id: 'tools/call', label: 'Call a tool' },
    { id: 'resources/read', label: 'Read a resource' },
    { id: 'prompts/get', label: 'Get a prompt' },
  ]

  let kind = $state<McpListKind>(untrack(() => KIND_OF[mcp.operation]))
  let query = $state('')
  /** Tools: edit the arguments as JSON text instead of the generated form. */
  let jsonMode = $state(false)
  /** The resource template whose fields are shown, and the values typed into them. */
  let template = $state<string | null>(null)
  let templateValues = $state<Record<string, string>>({})

  const items = (k: McpListKind): Item[] => (lists ? lists[k] : [])
  const keyOf = (k: McpListKind, it: Item): string => (k === 'resources' ? text(it.uri) : k === 'resourceTemplates' ? text(it.uriTemplate) : text(it.name))
  const labelOf = (k: McpListKind, it: Item): string => text(it.title) || text(it.name) || keyOf(k, it)

  const kindTabs = $derived(
    (Object.keys(KIND_LABEL) as McpListKind[]).map((k) => ({
      id: k,
      label: KIND_LABEL[k],
      badge: lists ? `${items(k).length}${lists.truncated[k] ? '+' : ''}` : undefined,
    })),
  )

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const all = items(kind)
    if (!q) return all
    return all.filter((it) => [it.name, it.title, it.description, it.uri, it.uriTemplate].some((v) => text(v).toLowerCase().includes(q)))
  })

  const tool = $derived(mcp.operation === 'tools/call' ? items('tools').find((t) => t.name === mcp.tool) : undefined)
  const resource = $derived(mcp.operation === 'resources/read' ? items('resources').find((r) => r.uri === mcp.uri) : undefined)
  const activeTemplate = $derived(mcp.operation === 'resources/read' && template ? items('resourceTemplates').find((t) => t.uriTemplate === template) : undefined)
  const prompt = $derived(mcp.operation === 'prompts/get' ? items('prompts').find((p) => p.name === mcp.prompt) : undefined)
  const selected = $derived(mcp.operation === 'tools/call' ? tool : mcp.operation === 'prompts/get' ? prompt : (resource ?? activeTemplate))
  const schema = $derived(tool && isObj(tool.inputSchema) ? tool.inputSchema : null)
  const promptArgs = $derived(prompt && Array.isArray(prompt.arguments) ? (prompt.arguments.filter(isObj) as Item[]) : [])

  // A request that reads a URI made from a template shows that template's fields once the lists are in.
  $effect(() => {
    if (template || mcp.operation !== 'resources/read' || !lists || resource) return
    for (const t of lists.resourceTemplates) {
      const values = matchTemplate(text(t.uriTemplate), mcp.uri)
      if (values) {
        template = text(t.uriTemplate)
        templateValues = values
        return
      }
    }
  })

  function isSelected(k: McpListKind, it: Item): boolean {
    if (k === 'tools') return mcp.operation === 'tools/call' && it.name === mcp.tool
    if (k === 'resources') return mcp.operation === 'resources/read' && it.uri === mcp.uri
    if (k === 'resourceTemplates') return mcp.operation === 'resources/read' && !resource && it.uriTemplate === template
    return mcp.operation === 'prompts/get' && it.name === mcp.prompt
  }

  function select(k: McpListKind, it: Item) {
    if (k === 'tools') {
      const name = text(it.name)
      const next = argumentsForTool(mcp.arguments)
      if (next !== mcp.arguments) mcp.arguments = next
      mcp.operation = 'tools/call'
      mcp.tool = name
    } else if (k === 'resources') {
      mcp.operation = 'resources/read'
      mcp.uri = text(it.uri)
      template = null
    } else if (k === 'resourceTemplates') {
      const t = text(it.uriTemplate)
      mcp.operation = 'resources/read'
      template = t
      templateValues = matchTemplate(t, mcp.uri) ?? {}
      mcp.uri = expandTemplate(t, templateValues)
    } else {
      mcp.operation = 'prompts/get'
      mcp.prompt = text(it.name)
      mcp.promptArguments = rowsForPrompt(it)
    }
  }

  /** The prompt's declared arguments as rows (values already typed for them kept), then any other rows. */
  function rowsForPrompt(p: Item): McpDraft['promptArguments'] {
    const existing = dataRows(mcp.promptArguments)
    const declared = (Array.isArray(p.arguments) ? p.arguments.filter(isObj) : []).map((a) => text(a.name)).filter(Boolean)
    const rows = declared.map((name) => existing.find((r) => r.key === name) ?? newRow({ key: name }))
    return ensureTrailingEmpty([...rows, ...existing.filter((r) => !declared.includes(r.key))])
  }

  function setOperation(v: string) {
    const op = OPERATIONS.find((o) => o.id === v)?.id
    if (!op || op === mcp.operation) return
    mcp.operation = op
    kind = KIND_OF[op]
  }

  function setTemplateValue(name: string, value: string) {
    if (!template) return
    templateValues = { ...templateValues, [name]: value }
    mcp.uri = expandTemplate(template, templateValues)
  }

  function setUri(v: string) {
    mcp.uri = v
    if (!template) return
    const values = matchTemplate(template, v)
    if (values) templateValues = values
    else template = null
  }

  const annotations = $derived.by(() => {
    const a = tool && isObj(tool.annotations) ? tool.annotations : {}
    const out: { label: string; tone: 'muted' | 'warning' }[] = []
    if (a.readOnlyHint === true) out.push({ label: 'read-only', tone: 'muted' })
    if (a.destructiveHint === true) out.push({ label: 'destructive', tone: 'warning' })
    if (a.idempotentHint === true) out.push({ label: 'idempotent', tone: 'muted' })
    if (a.openWorldHint === true) out.push({ label: 'open world', tone: 'muted' })
    return out
  })
</script>

<div class="flex h-full min-h-0">
  <!-- What the server offers -->
  <div class="flex w-64 shrink-0 flex-col border-r border-border" data-testid="mcp-capability-list">
    <Tabs tabs={kindTabs} value={kind} onchange={(v) => (kind = v as McpListKind)} label="Server capabilities" idPrefix="mcp-{tab.id}-kind" class="scroll-strip shrink-0 overflow-x-auto overflow-y-hidden px-1 text-xs" />
    <div class="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <input type="search" class="h-7 min-w-0 flex-1 text-xs" placeholder="Search {KIND_LABEL[kind].toLowerCase()}" aria-label="Search {KIND_LABEL[kind].toLowerCase()}" bind:value={query} />
      {#if onrefresh && lists}<IconButton icon="refresh" label="Reload the lists" onclick={onrefresh} disabled={loading} />{/if}
    </div>
    <!-- A list that failed to load does not hide the ones that did. -->
    {#if listError && lists}<p class="border-b border-border px-2 py-1.5 text-xs text-danger" role="alert" data-testid="mcp-list-error">{listError}</p>{/if}
    <div class="min-h-0 flex-1 overflow-auto" role="tabpanel" id="mcp-{tab.id}-kind-panel-{kind}" aria-labelledby="mcp-{tab.id}-kind-{kind}">
      {#if loading && !lists}
        <div class="flex items-center gap-2 p-3 text-xs text-muted"><Spinner class="h-3 w-3" /> Loading…</div>
      {:else if listError && !lists}
        <p class="p-3 text-xs text-danger" role="alert">{listError}</p>
      {:else if !lists}
        <p class="p-3 text-xs text-muted" data-testid="mcp-list-empty">Connect to see what the server offers.</p>
      {:else if shown.length === 0}
        <p class="p-3 text-xs text-muted">{query.trim() ? 'Nothing matches.' : `The server lists no ${KIND_LABEL[kind].toLowerCase()}.`}</p>
      {:else}
        <ul aria-label={KIND_LABEL[kind]}>
          {#each shown as it (keyOf(kind, it))}
            <li>
              <button
                type="button"
                class="block w-full border-l-2 px-2 py-1.5 text-left text-xs {isSelected(kind, it) ? 'border-accent bg-accent-soft text-fg' : 'border-transparent hover:bg-hover'}"
                aria-current={isSelected(kind, it) ? 'true' : undefined}
                onclick={() => select(kind, it)}
              >
                <span class="block truncate font-medium">{labelOf(kind, it)}</span>
                {#if kind === 'resources' || kind === 'resourceTemplates'}<span class="block truncate font-mono text-[11px] text-muted">{keyOf(kind, it)}</span>
                {:else if text(it.description)}<span class="block truncate text-muted">{text(it.description)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if lists?.truncated[kind]}<p class="p-2 text-[11px] text-faint">Only the first 1000 are shown.</p>{/if}
    </div>
  </div>

  <!-- The operation and its form -->
  <div class="min-w-0 flex-1 space-y-3 overflow-auto p-3" data-testid="mcp-call-form">
    <div class="flex flex-wrap items-end gap-2">
      <div class="grid gap-1">
        <label for="mcp-op-{tab.id}" class="text-xs text-muted">Operation</label>
        <select id="mcp-op-{tab.id}" class="h-8 w-40" value={mcp.operation} onchange={(e) => setOperation(e.currentTarget.value)}>
          {#each OPERATIONS as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
        </select>
      </div>
      {#if mcp.operation === 'tools/call'}
        <div class="grid min-w-48 flex-1 gap-1">
          <label for="mcp-tool-{tab.id}" class="text-xs text-muted">Tool</label>
          <input id="mcp-tool-{tab.id}" class="h-8 font-mono" placeholder="Pick a tool on the left or type its name" value={mcp.tool} oninput={(e) => (mcp.tool = e.currentTarget.value)} />
        </div>
      {:else if mcp.operation === 'prompts/get'}
        <div class="grid min-w-48 flex-1 gap-1">
          <label for="mcp-prompt-{tab.id}" class="text-xs text-muted">Prompt</label>
          <input id="mcp-prompt-{tab.id}" class="h-8 font-mono" placeholder="Pick a prompt on the left or type its name" value={mcp.prompt} oninput={(e) => (mcp.prompt = e.currentTarget.value)} />
        </div>
      {:else}
        <div class="grid min-w-48 flex-1 gap-1">
          <span class="text-xs text-muted">Resource URI</span>
          <div class="flex h-8 items-center rounded border border-border bg-surface px-1 focus-within:border-accent">
            <TemplateInput class="w-full !border-transparent" mono label="Resource URI" placeholder="file:///path or demo://readme" value={mcp.uri} oninput={setUri} />
          </div>
        </div>
      {/if}
    </div>

    {#if selected}
      <div class="space-y-1" data-testid="mcp-selected">
        <div class="flex flex-wrap items-center gap-1.5">
          <h3 class="text-sm font-semibold">{labelOf(KIND_OF[mcp.operation], selected)}</h3>
          {#if text(selected.title) && text(selected.name)}<span class="font-mono text-xs text-muted">{text(selected.name)}</span>{/if}
          {#if text(selected.mimeType)}<span class="rounded bg-raised px-1.5 text-[11px] text-muted">{text(selected.mimeType)}</span>{/if}
          {#each annotations as a (a.label)}<span class="rounded px-1.5 text-[11px] {a.tone === 'warning' ? 'bg-warning-soft text-fg' : 'bg-raised text-muted'}">{a.label}</span>{/each}
        </div>
        {#if text(selected.description)}<p class="whitespace-pre-wrap text-xs text-muted">{text(selected.description)}</p>{/if}
      </div>
    {/if}

    {#if mcp.operation === 'tools/call'}
      <section class="space-y-1">
        <div class="flex items-center gap-1">
          <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">Arguments</h4>
          <InfoTip label="About tool arguments">
            <span>The form is made from the tool's input schema. Values may use <code>{'{{variables}}'}</code>; in a number or true/false field, a variable is replaced by its value as a number or boolean.</span>
          </InfoTip>
          {#if schema}
            <button type="button" class="ml-auto rounded px-2 py-0.5 text-xs hover:bg-hover {jsonMode ? 'bg-accent-soft text-fg' : 'text-muted'}" aria-pressed={jsonMode} onclick={() => (jsonMode = !jsonMode)}>JSON</button>
          {/if}
        </div>
        {#if schema && !jsonMode}
          <SchemaForm {schema} value={mcp.arguments} onchange={(t) => (mcp.arguments = t)} templates />
        {:else}
          <CodeEditor value={mcp.arguments} onchange={(t) => (mcp.arguments = t)} language="json" templates label="Tool arguments (JSON)" class="h-48 rounded border border-border" />
          {#if !schema}<p class="text-xs text-faint">{lists ? 'This tool is not in the server’s list; enter its arguments as JSON.' : 'Connect to get a form for this tool, or enter its arguments as JSON.'}</p>{/if}
        {/if}
      </section>
    {:else if mcp.operation === 'resources/read'}
      {#if activeTemplate && template}
        <section class="space-y-2" aria-label="Template values">
          <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">Template values</h4>
          {#each templateVars(template) as v (v)}
            <div class="grid max-w-xl gap-1">
              <span class="font-mono text-xs text-muted">{v}</span>
              <div class="rounded border border-border bg-surface px-1 py-0.5 focus-within:border-accent">
                <TemplateInput class="w-full !border-transparent" mono label={v} value={templateValues[v] ?? ''} oninput={(x) => setTemplateValue(v, x)} />
              </div>
            </div>
          {/each}
        </section>
      {/if}
    {:else}
      <section class="space-y-1">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">Arguments</h4>
        <KeyValueTable rows={mcp.promptArguments} onchange={(rows) => (mcp.promptArguments = rows)} noun="Prompt argument" keyPlaceholder="Name" description={false} duplicates="exact" />
        {#if promptArgs.length}
          <ul class="space-y-0.5 pt-1 text-xs text-muted" aria-label="Declared arguments">
            {#each promptArgs as a (text(a.name))}
              <li><span class="font-mono text-fg">{text(a.name)}</span>{#if a.required === true}<span class="text-danger" title="Required"> *</span>{/if}{#if text(a.description)}: {text(a.description)}{/if}</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
</div>
