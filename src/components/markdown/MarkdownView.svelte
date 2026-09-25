<script lang="ts">
  /**
   * Rendered documentation. The HTML comes from `renderDocs` (marked + DOMPurify, see render.ts). Every link
   * click is intercepted here: http(s)/mailto open in the OS browser via `openExternalUrl`, `#fragments` (and
   * relative links with one) scroll within the doc, anything else does nothing. The app window never navigates.
   */
  import { toast } from '../../app/toast.svelte'
  import type { DescriptionFormat } from '../../lib/description'
  import { api, errorInfo } from '../../lib/ipc'
  import './markdown.css'
  import { EXTERNAL_URL, renderDocs, slugify } from './render'

  interface Props {
    source: string
    format?: DescriptionFormat
    label?: string
    class?: string
  }
  let { source, format = 'markdown', label = 'Documentation', class: cls = '' }: Props = $props()

  let root: HTMLDivElement
  const html = $derived(renderDocs(source, format))

  function scrollToAnchor(fragment: string): boolean {
    let raw = fragment
    try {
      raw = decodeURIComponent(fragment)
    } catch {
      /* keep as is */
    }
    for (const key of [raw, raw.toLowerCase(), slugify(raw)]) {
      const target = root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(key)}"]`)
      if (target) {
        target.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
        return true
      }
    }
    return false
  }

  async function openExternal(href: string) {
    try {
      await api().openExternalUrl(href)
    } catch (e) {
      toast.error('Could not open link', errorInfo(e).message)
    }
  }

  function onclick(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const href = (a.getAttribute('href') ?? '').trim()
    if (!href) return
    if (href.startsWith('#')) return void scrollToAnchor(href.slice(1))
    if (EXTERNAL_URL.test(href)) return void openExternal(href)
    // Relative link: there is no document base to resolve it against; honour its #fragment if it has one.
    const hash = href.indexOf('#')
    if (hash < 0 || !scrollToAnchor(href.slice(hash + 1))) toast.info('Link not opened', `“${href}” is a relative link; only web and mail links open.`)
  }

  /** Middle click / drag would bypass the click handler; links never leave through them. */
  function onauxclick(e: MouseEvent) {
    if ((e.target as Element | null)?.closest?.('a')) e.preventDefault()
  }
  function ondragstart(e: DragEvent) {
    if ((e.target as Element | null)?.closest?.('a, img')) e.preventDefault()
  }
</script>

<!-- Link activation (click / Enter on a focused link) is delegated to this container. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div bind:this={root} class="md-doc {cls}" role="document" aria-label={label} data-testid="markdown-view" {onclick} {onauxclick} {ondragstart}>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by render.ts (DOMPurify allowlist) -->
  {@html html}
</div>
