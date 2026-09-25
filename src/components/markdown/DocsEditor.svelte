<script lang="ts">
  /**
   * Documentation editor used by the request Docs tab and the collection/folder overview: rendered Preview
   * (the default), a CodeMirror Markdown editor, or both side by side. Read-only callers only get Preview.
   */
  import { settings } from '../../app/settings.svelte'
  import type { DescriptionFormat, DocsMode } from '../../lib/description'
  import CodeEditor from '../editor/CodeEditor.svelte'
  import Button from '../ui/Button.svelte'
  import SplitPane from '../ui/SplitPane.svelte'
  import MarkdownView from './MarkdownView.svelte'

  interface Props {
    value: string
    onchange?: (value: string) => void
    format?: DescriptionFormat
    readOnly?: boolean
    readOnlyReason?: string
    /** Current mode; null = default (Preview). */
    mode?: DocsMode | null
    onmodechange?: (mode: DocsMode) => void
    label: string
    idPrefix: string
    /** Short text at the right of the toolbar (e.g. where the doc is stored). */
    hint?: string
    class?: string
  }
  let {
    value,
    onchange,
    format = 'markdown',
    readOnly = false,
    readOnlyReason,
    mode = null,
    onmodechange,
    label,
    idPrefix,
    hint = '',
    class: cls = '',
  }: Props = $props()

  let focusEditor = $state(false)
  const effective = $derived<DocsMode>(readOnly ? 'preview' : (mode ?? 'preview'))
  const empty = $derived(value.trim() === '')
  const language = $derived(format === 'plain' ? 'text' : 'markdown')

  const MODES: Array<{ id: DocsMode; label: string }> = [
    { id: 'preview', label: 'Preview' },
    { id: 'edit', label: 'Edit' },
    { id: 'split', label: 'Split' },
  ]

  function choose(m: DocsMode, focus = false) {
    focusEditor = focus
    onmodechange?.(m)
  }
</script>

{#snippet editor()}
  <CodeEditor
    {value}
    onchange={(v) => onchange?.(v)}
    {language}
    wrap={settings.editorWrap}
    lineNumbers={false}
    templates
    autoFocus={focusEditor}
    placeholder={format === 'plain' ? 'Plain-text documentation…' : 'Write Markdown: # headings, **bold**, `code`, tables, - [ ] task lists, [links](https://…)'}
    label="{label} (Markdown source)"
    class="h-full"
  />
{/snippet}

{#snippet preview()}
  <div class="h-full min-h-0 overflow-auto px-4 py-3" data-testid="docs-preview">
    {#if empty}
      <div class="flex h-full min-h-24 flex-col items-center justify-center gap-2 text-center text-sm text-muted" data-testid="docs-empty">
        <p>No documentation yet.</p>
        {#if !readOnly}
          <Button icon="edit" onclick={() => choose('edit', true)}>Add documentation</Button>
        {/if}
      </div>
    {:else}
      <MarkdownView source={value} {format} {label} />
    {/if}
  </div>
{/snippet}

<div class="flex h-full min-h-0 flex-col {cls}">
  <div class="flex items-center gap-2 border-b border-border px-3 py-1">
    <div class="flex items-center rounded border border-border p-0.5" role="group" aria-label="{label} view">
      {#each MODES as m (m.id)}
        {@const disabled = readOnly && m.id !== 'preview'}
        <button
          type="button"
          id="{idPrefix}-docs-{m.id}"
          aria-pressed={effective === m.id}
          {disabled}
          title={disabled ? readOnlyReason : m.label}
          class="rounded px-2 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 {effective === m.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'}"
          onclick={() => choose(m.id, m.id !== 'preview')}
        >
          {m.label}
        </button>
      {/each}
    </div>
    {#if format === 'plain'}
      <span class="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted" title="Imported as text/plain: shown verbatim, not as Markdown">Plain text</span>
    {/if}
    {#if hint}<span class="ml-auto truncate text-xs text-faint">{hint}</span>{/if}
  </div>
  <div class="min-h-0 flex-1">
    {#if effective === 'edit'}
      {@render editor()}
    {:else if effective === 'split'}
      <SplitPane direction="row" storageKey="slinger.split.docs" initial={0.5} class="h-full min-h-0">
        {#snippet first()}{@render editor()}{/snippet}
        {#snippet second()}<div class="h-full border-l border-border">{@render preview()}</div>{/snippet}
      </SplitPane>
    {:else}
      {@render preview()}
    {/if}
  </div>
</div>
