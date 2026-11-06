<script lang="ts">
  /**
   * Body > GraphQL: the query (GraphQL highlighting; field, argument, type and enum completion once a schema is fetched)
   * and the variables (JSON, checked like a raw JSON body) side by side, the optional operation name, "Fetch schema"
   * and a small schema browser. The schema is kept in memory per request URL (graphqlSchemas.svelte.ts).
   */
  import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
  import { app } from '../../app/state.svelte'
  import { settings } from '../../app/settings.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import Button from '../../components/ui/Button.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { emptyGraphql, operationNames } from '../../lib/graphql'
  import { graphqlCompletions } from '../../lib/graphqlComplete'
  import { checkJson } from '../../lib/jsonTemplate'
  import GraphqlSchemaBrowser from './GraphqlSchemaBrowser.svelte'
  import { graphqlSchemas } from './graphqlSchemas.svelte'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()

  // Drafts restored from tabs saved before 0.30 may lack it (upgradeDraft adds it; this is the fallback).
  const g = $derived(tab.draft.body.graphql ?? emptyGraphql())
  const set = (patch: Partial<typeof g>) => (tab.draft.body.graphql = { ...g, ...patch })

  const entry = $derived(graphqlSchemas.get(app.workspaceId, tab.draft.url))
  const schema = $derived(entry?.schema ?? null)
  let showSchema = $state(false)

  const varsCheck = $derived.by(() => {
    const t = g.variables.trim()
    if (!t) return null
    const c = checkJson(g.variables)
    if (!c.ok) return { ok: false, text: `Invalid JSON: ${c.error}` }
    return t.startsWith('{') ? { ok: true, text: 'Valid JSON' } : { ok: false, text: 'The variables must be a JSON object, like {"id": 1}.' }
  })
  const operations = $derived(operationNames(g.query))

  /** Field / argument / type completion from the fetched schema (none before a fetch). */
  function schemaCompletion(ctx: CompletionContext): CompletionResult | null {
    const s = schema
    if (!s) return null
    const word = ctx.matchBefore(/[_A-Za-z][_0-9A-Za-z]*/)
    if (!word && !ctx.explicit) return null
    const r = graphqlCompletions(s, ctx.state.doc.toString(), ctx.pos)
    if (!r || r.options.length === 0) return null
    const options: Completion[] = r.options.map((o) => ({ label: o.label, type: o.type, detail: o.detail, info: o.info }))
    return { from: r.from, options, validFor: /^[_A-Za-z0-9]*$/ }
  }

  async function fetchSchema() {
    if (!app.workspaceId) return
    const result = await graphqlSchemas.fetch({
      workspaceId: app.workspaceId,
      collectionId: tab.collectionId,
      folderId: tab.folderId,
      draft: $state.snapshot(tab.draft) as typeof tab.draft,
    })
    if (result.schema && !result.error) showSchema = true
  }

  const typeCount = $derived(schema ? Object.keys(schema.types).filter((n) => !n.startsWith('__')).length : 0)
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2">
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <Button size="sm" icon="refresh" loading={entry?.loading} disabled={!tab.draft.url.trim()} onclick={fetchSchema}>Fetch schema</Button>
    {#if entry?.error}
      <span class="min-w-0 truncate text-danger" role="alert" title={entry.error}>{entry.error}</span>
    {:else if schema}
      <span class="text-muted" data-testid="graphql-schema-status">Schema: {typeCount} types</span>
      <Button size="sm" variant="ghost" icon="list" aria-pressed={showSchema} onclick={() => (showSchema = !showSchema)}>
        {showSchema ? 'Hide schema' : 'Show schema'}
      </Button>
    {/if}
    <InfoTip label="About GraphQL bodies">
      The query and variables are sent as JSON <code>{'{"query", "variables", "operationName"}'}</code> with
      <code>Content-Type: application/json</code> (unless you set your own), using the method you chose. <code>{'{{variables}}'}</code>
      work in both editors.
      <br /><br />
      <b>Fetch schema</b> sends the standard introspection query to this URL as a POST, with the request's headers, auth, environment
      and cookies (no scripts), and keeps the schema in memory for this URL: it completes fields, arguments, types and enum values as you
      type (Ctrl+Space) and the schema browser lists the types.
    </InfoTip>
    <label class="ml-auto flex items-center gap-1.5">
      <span class="text-muted">Operation</span>
      <input
        class="h-6 w-40 py-0 text-xs"
        aria-label="GraphQL operation name"
        placeholder={operations.length > 1 ? 'Required: several operations' : 'Optional'}
        list="gql-ops-{tab.id}"
        value={g.operationName}
        oninput={(e) => set({ operationName: e.currentTarget.value })}
      />
      <datalist id="gql-ops-{tab.id}">
        {#each operations as op (op)}<option value={op}></option>{/each}
      </datalist>
    </label>
  </div>

  <div class="flex min-h-40 flex-1 gap-2">
    <div class="flex min-w-0 flex-[3] flex-col">
      <span class="mb-1 text-xs text-muted">Query</span>
      <div class="min-h-0 flex-1 overflow-hidden rounded border border-border">
        <CodeEditor
          value={g.query}
          onchange={(v) => set({ query: v })}
          language="graphql"
          wrap={settings.editorWrap}
          templates
          label="GraphQL query"
          placeholder={'query {\n  field\n}'}
          completionSources={[schemaCompletion]}
        />
      </div>
    </div>
    <div class="flex min-w-0 flex-[2] flex-col">
      <span class="mb-1 text-xs text-muted">Variables (JSON)</span>
      <div class="min-h-0 flex-1 overflow-hidden rounded border border-border">
        <CodeEditor
          value={g.variables}
          onchange={(v) => set({ variables: v })}
          language="json"
          wrap={settings.editorWrap}
          templates
          label="GraphQL variables"
          placeholder={'{ "id": 1 }'}
        />
      </div>
      {#if varsCheck}
        <p class="mt-1 text-xs {varsCheck.ok ? 'text-success' : 'text-danger'}" role={varsCheck.ok ? undefined : 'alert'}>{varsCheck.text}</p>
      {/if}
    </div>
    {#if showSchema && schema}
      <div class="flex w-64 min-w-0 shrink-0 flex-col overflow-hidden rounded border border-border">
        <GraphqlSchemaBrowser {schema} />
      </div>
    {/if}
  </div>
</div>
