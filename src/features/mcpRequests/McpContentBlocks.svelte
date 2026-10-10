<script lang="ts" module>
  import { suggestFileName } from '../../lib/hex'

  /**
   * How one MCP content block is shown. Blocks come straight from the server (tools/call `content`, prompts/get message
   * `content`, resources/read `contents` wrapped as embedded resources), so every field is checked before use.
   */
  export type McpBlockView =
    | { kind: 'text'; text: string }
    | { kind: 'image'; mime: string; data: string; byteLength: number; preview: boolean }
    | { kind: 'audio'; mime: string; data: string; byteLength: number; preview: false }
    | { kind: 'resource_link'; uri: string; name: string; title: string; description: string; mime: string }
    | { kind: 'resource'; uri: string; mime: string; text: string | null; blob: string | null; byteLength: number; preview: boolean }
    | { kind: 'unknown'; type: string; json: string }

  /** Longest text a block renders before "Show all" (a long text node in the DOM is slow to lay out). */
  export const BLOCK_TEXT_LIMIT = 100_000

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
  const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/
  // Only well-formed image types become a data: URL (the CSP allows data: images; <img> never runs script, even for SVG).
  const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

  /** Decoded size of a base64 string without decoding it. */
  export function base64ByteLength(b64: string): number {
    const s = b64.replace(/\s/g, '')
    if (!s) return 0
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((s.length * 3) / 4) - pad)
  }

  function canPreviewImage(mime: string, data: string): boolean {
    return IMAGE_MIME.test(mime) && data !== '' && BASE64.test(data)
  }

  export function describeBlock(block: unknown): McpBlockView {
    const b = rec(block)
    const type = str(b?.type)
    if (b && type === 'text' && typeof b.text === 'string') return { kind: 'text', text: b.text }
    if (b && (type === 'image' || type === 'audio') && typeof b.data === 'string') {
      const mime = str(b.mimeType).trim().toLowerCase()
      // Audio is never previewed: the renderer CSP has no media-src, so a data: <audio> would not load. It can be saved.
      const media = { mime, data: b.data, byteLength: base64ByteLength(b.data) }
      return type === 'image' ? { kind: 'image', ...media, preview: canPreviewImage(mime, b.data) } : { kind: 'audio', ...media, preview: false }
    }
    if (b && type === 'resource_link' && typeof b.uri === 'string') {
      return { kind: 'resource_link', uri: b.uri, name: str(b.name), title: str(b.title), description: str(b.description), mime: str(b.mimeType) }
    }
    const r = rec(b?.resource)
    if (b && type === 'resource' && r) {
      const mime = str(r.mimeType).trim().toLowerCase()
      const text = typeof r.text === 'string' ? r.text : null
      const blob = text === null && typeof r.blob === 'string' ? r.blob : null
      return {
        kind: 'resource',
        uri: str(r.uri),
        mime,
        text,
        blob,
        byteLength: blob !== null ? base64ByteLength(blob) : text !== null ? new TextEncoder().encode(text).length : 0,
        preview: blob !== null && canPreviewImage(mime, blob),
      }
    }
    let json: string
    try {
      json = JSON.stringify(block, null, 2) ?? String(block)
    } catch {
      json = String(block)
    }
    return { kind: 'unknown', type: type || typeof block, json }
  }

  const EXT: Record<string, string> = {
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'text/markdown': 'md',
  }

  /** Download name: the URI's last path segment when it has an extension, else `content.<ext from mime>`. */
  export function blockFileName(mime: string, uri = ''): string {
    const last = uri.split(/[?#]/)[0].split('/').pop() ?? ''
    let segment = last
    try {
      segment = decodeURIComponent(last)
    } catch {
      /* keep it encoded */
    }
    segment = segment.replace(/[\\/:*?"<>|]/g, '_').trim()
    if (/^[^.].*\.[A-Za-z0-9]{1,8}$/.test(segment)) return segment
    const base = mime.split(';')[0].trim().toLowerCase()
    if (EXT[base]) return `content.${EXT[base]}`
    const name = suggestFileName(base).replace(/^response\./, 'content.')
    return base.startsWith('text/') && name.endsWith('.bin') ? 'content.txt' : name
  }
</script>

<script lang="ts">
  /** MCP content blocks (text, image, audio, resource link, embedded resource) as a list of cards, each with copy/save. */
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import { saveExport } from '../../lib/exportFile'
  import { errorInfo } from '../../lib/ipc'
  import { dataUrl, formatBytes } from '../../lib/response'

  interface Props {
    blocks: unknown[]
    /** Accessible name of the list. */
    label?: string
    /** Shown when there are no blocks. */
    emptyText?: string
  }
  let { blocks, label = 'Content', emptyText = 'No content.' }: Props = $props()

  const views = $derived(blocks.map(describeBlock))
  // Indices of blocks whose long text is shown in full; a new result starts truncated again.
  let showAll = $state<number[]>([])
  $effect(() => {
    void blocks
    showAll = []
  })

  const KIND_LABEL: Record<McpBlockView['kind'], string> = {
    text: 'Text',
    image: 'Image',
    audio: 'Audio',
    resource_link: 'Resource link',
    resource: 'Resource',
    unknown: 'Other',
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} copied`)
    } catch {
      toast.error('Could not copy', 'Clipboard access was denied.')
    }
  }

  async function save(name: string, contents: string, encoding: 'utf8' | 'base64') {
    try {
      toast.success('Content saved', await saveExport(name, contents, encoding))
    } catch (e) {
      toast.error('Could not save the content', errorInfo(e).message)
    }
  }

  const clip = (text: string, i: number) => (showAll.includes(i) || text.length <= BLOCK_TEXT_LIMIT ? text : text.slice(0, BLOCK_TEXT_LIMIT))
</script>

{#snippet longText(text: string, i: number)}
  <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs">{clip(text, i)}</pre>
  {#if text.length > BLOCK_TEXT_LIMIT && !showAll.includes(i)}
    <div class="flex items-center gap-2 border-t border-border bg-warning-soft px-3 py-1 text-xs text-warning">
      <span>Long text ({formatBytes(new TextEncoder().encode(text).length)}). Showing the first {BLOCK_TEXT_LIMIT.toLocaleString('en')} characters.</span>
      <Button size="sm" onclick={() => (showAll = [...showAll, i])}>Show all</Button>
    </div>
  {/if}
{/snippet}

{#snippet image(mime: string, data: string, alt: string)}
  <div class="flex justify-center overflow-auto p-3">
    <img
      src={dataUrl(mime, data.replace(/\s/g, ''))}
      {alt}
      class="max-h-80 max-w-full object-contain"
      style="background: repeating-conic-gradient(var(--surface-raised) 0% 25%, var(--surface) 0% 50%) 50% / 16px 16px"
    />
  </div>
{/snippet}

{#if views.length === 0}
  <p class="text-sm text-muted" data-testid="mcp-blocks-empty">{emptyText}</p>
{:else}
  <ol class="flex flex-col gap-2" aria-label={label}>
    {#each views as v, i (i)}
      <li class="min-w-0 overflow-hidden rounded border border-border bg-surface" data-testid="mcp-block" data-kind={v.kind}>
        <div class="flex min-h-8 flex-wrap items-center gap-2 border-b border-border bg-raised px-3 py-0.5 text-xs">
          <span class="font-semibold">{KIND_LABEL[v.kind]}</span>
          {#if v.kind === 'image' || v.kind === 'audio'}
            <span class="text-muted">{v.mime || 'unknown type'} · {formatBytes(v.byteLength)}</span>
          {:else if v.kind === 'resource'}
            <code class="min-w-0 truncate text-muted" title={v.uri}>{v.uri}</code>
            {#if v.mime}<span class="text-faint">{v.mime}</span>{/if}
            <span class="text-faint">{formatBytes(v.byteLength)}</span>
          {:else if v.kind === 'resource_link'}
            {#if v.mime}<span class="text-faint">{v.mime}</span>{/if}
          {:else if v.kind === 'unknown'}
            <code class="text-muted">{v.type}</code>
          {/if}
          <span class="ml-auto flex items-center gap-0.5">
            {#if v.kind === 'text'}
              <IconButton icon="copy" label="Copy text" onclick={() => copy(v.text, 'Text')} />
            {:else if v.kind === 'image' || v.kind === 'audio'}
              <IconButton icon="download" label="Save {v.kind} to file" onclick={() => save(blockFileName(v.mime), v.data.replace(/\s/g, ''), 'base64')} />
            {:else if v.kind === 'resource_link'}
              <IconButton icon="copy" label="Copy URI" onclick={() => copy(v.uri, 'URI')} />
            {:else if v.kind === 'resource'}
              {#if v.text !== null}
                <IconButton icon="copy" label="Copy text" onclick={() => copy(v.text ?? '', 'Text')} />
              {/if}
              <IconButton
                icon="download"
                label="Save resource to file"
                onclick={() => (v.blob !== null ? save(blockFileName(v.mime, v.uri), v.blob.replace(/\s/g, ''), 'base64') : save(blockFileName(v.mime || 'text/plain', v.uri), v.text ?? '', 'utf8'))}
              />
            {:else}
              <IconButton icon="copy" label="Copy JSON" onclick={() => copy(v.json, 'JSON')} />
            {/if}
          </span>
        </div>
        {#if v.kind === 'text'}
          {@render longText(v.text, i)}
        {:else if v.kind === 'image'}
          {#if v.preview}
            {@render image(v.mime, v.data, `Image content ${i + 1}`)}
          {:else}
            <p class="px-3 py-2 text-sm text-muted">This image cannot be shown here. Use “Save image to file” to keep it.</p>
          {/if}
        {:else if v.kind === 'audio'}
          <p class="px-3 py-2 text-sm text-muted">Audio is not played inside Slinger. Use “Save audio to file” and open it in a player.</p>
        {:else if v.kind === 'resource_link'}
          <div class="flex flex-col gap-0.5 px-3 py-2 text-sm">
            <span class="font-medium">{v.title || v.name || v.uri}</span>
            <code class="break-all text-xs text-muted">{v.uri}</code>
            {#if v.description}<p class="text-xs text-muted">{v.description}</p>{/if}
          </div>
        {:else if v.kind === 'resource'}
          {#if v.text !== null}
            {@render longText(v.text, i)}
          {:else if v.preview && v.blob !== null}
            {@render image(v.mime, v.blob, v.uri || `Resource ${i + 1}`)}
          {:else}
            <p class="px-3 py-2 text-sm text-muted">Binary resource. Use “Save resource to file” to keep it.</p>
          {/if}
        {:else}
          <pre class="max-h-80 overflow-auto px-3 py-2 font-mono text-xs">{v.json}</pre>
        {/if}
      </li>
    {/each}
  </ol>
{/if}
