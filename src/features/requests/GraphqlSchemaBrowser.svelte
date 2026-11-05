<script lang="ts">
  /**
   * A small browser for a fetched GraphQL schema: the types (root types first) with a filter, and one type's fields,
   * arguments, enum values or members with their descriptions. Type names in a field's type open that type.
   */
  import Button from '../../components/ui/Button.svelte'
  import { schemaTypeList, type GqlSchema, type GqlType } from '../../lib/graphql'

  let { schema }: { schema: GqlSchema } = $props()

  let filter = $state('')
  let selected = $state<string | null>(null)
  const all = $derived(schemaTypeList(schema))
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase()
    return q ? all.filter((t) => t.name.toLowerCase().includes(q) || t.fields.some((f) => f.name.toLowerCase().includes(q))) : all
  })
  const type = $derived<GqlType | null>(selected ? (schema.types[selected] ?? null) : null)

  const roots = $derived(new Map([[schema.queryType, 'query'], [schema.mutationType, 'mutation'], [schema.subscriptionType, 'subscription']]))
  const kindLabel = (t: GqlType) => roots.get(t.name) ?? t.kind.toLowerCase().replace('_', ' ')
  const firstLine = (text: string) => text.split('\n')[0]
  const open = (name: string) => {
    if (schema.types[name]) selected = name
  }
</script>

<div class="flex h-full min-h-0 flex-col text-sm" data-testid="graphql-schema-browser">
  {#if type}
    <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
      <Button size="sm" variant="ghost" onclick={() => (selected = null)} aria-label="Back to all types">All types</Button>
      <span class="min-w-0 truncate font-medium">{type.name}</span>
      <span class="text-xs text-faint">{kindLabel(type)}</span>
    </div>
    <div class="min-h-0 flex-1 overflow-auto px-2 py-1.5">
      {#if type.description}<p class="mb-2 whitespace-pre-wrap text-xs text-muted">{type.description}</p>{/if}
      {#if type.fields.length > 0}
        <ul class="space-y-1.5" aria-label="Fields of {type.name}">
          {#each type.fields as f (f.name)}
            <li>
              <div class="font-mono text-xs">
                <span class={f.deprecated ? 'line-through' : ''}>{f.name}</span>{#if f.args.length > 0}<span class="text-faint"
                    >({f.args.map((a) => `${a.name}: ${a.type}`).join(', ')})</span
                  >{/if}<span class="text-faint">: </span><button
                  type="button"
                  class="text-accent-text hover:underline disabled:text-muted disabled:no-underline"
                  disabled={!schema.types[f.typeName] || schema.types[f.typeName].kind === 'SCALAR'}
                  onclick={() => open(f.typeName)}>{f.type}</button
                >
              </div>
              {#if f.description}<p class="whitespace-pre-wrap text-xs text-muted">{f.description}</p>{/if}
              {#if f.deprecated}<p class="text-xs text-warning">Deprecated: {f.deprecated}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if type.enumValues.length > 0}
        <ul class="space-y-1" aria-label="Values of {type.name}">
          {#each type.enumValues as v (v.name)}
            <li>
              <span class="font-mono text-xs {v.deprecated ? 'line-through' : ''}">{v.name}</span>
              {#if v.description}<span class="text-xs text-muted"> — {v.description}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if type.possibleTypes.length > 0}
        <p class="mt-2 text-xs text-faint">{type.kind === 'UNION' ? 'Members' : 'Implemented by'}</p>
        <div class="flex flex-wrap gap-x-2 font-mono text-xs">
          {#each type.possibleTypes as p (p)}<button type="button" class="text-accent-text hover:underline" onclick={() => open(p)}>{p}</button>{/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="border-b border-border p-1.5">
      <input class="h-7 w-full" type="search" placeholder="Filter types and fields" aria-label="Filter schema types" bind:value={filter} />
    </div>
    <ul class="min-h-0 flex-1 overflow-auto py-1" aria-label="Schema types">
      {#each shown as t (t.name)}
        <li>
          <button type="button" class="block w-full px-2 py-1 text-left hover:bg-hover" onclick={() => (selected = t.name)} title={t.description || undefined}>
            <span class="font-mono text-xs">{t.name}</span>
            <span class="text-xs text-faint">{kindLabel(t)}</span>
            {#if t.description}<span class="block truncate text-xs text-muted">{firstLine(t.description)}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="px-2 py-3 text-xs text-muted">No type matches.</li>
      {/each}
    </ul>
  {/if}
</div>
