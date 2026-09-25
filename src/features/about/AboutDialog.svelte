<script lang="ts">
  /**
   * About Slinger: version (+ copy version info for bug reports), the developer and project links (credits.ts), the
   * story, the Sling Manifesto and the open-source acknowledgements (generated at build time from node_modules,
   * scripts/acknowledgements.mjs). Every link opens in the system browser through `openExternalUrl`.
   */
  import { onMount } from 'svelte'
  import ACKNOWLEDGEMENTS from 'virtual:acknowledgements'
  import appIcon from '../../../build/icons/128x128.png'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { CREDITS, INSPIRATION, MANIFESTO, SIGN_OFF, TAGLINE } from './credits'
  import SlingGlyph from './SlingGlyph.svelte'
  import { formatVersionInfo } from './versionInfo'

  let version = $state<string | null>(null)
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    api().getAppVersion().then((v) => (version = v), () => (version = null))
    return () => clearTimeout(copyTimer)
  })

  const groups = [
    { id: 'app', title: 'App and runtime', items: ACKNOWLEDGEMENTS.filter((a) => a.group === 'app') },
    { id: 'sandbox', title: 'Script sandbox (pm.require)', items: ACKNOWLEDGEMENTS.filter((a) => a.group === 'sandbox') },
  ].filter((g) => g.items.length > 0)

  async function openLink(url: string) {
    try {
      await api().openExternalUrl(url)
    } catch (e) {
      toast.error('Could not open link', errorInfo(e).message)
    }
  }

  /** Links are real anchors (focusable, announced as links) but never navigate the app window. */
  function onLinkClick(e: MouseEvent, url: string) {
    e.preventDefault()
    void openLink(url)
  }
  function blockAux(e: MouseEvent) {
    e.preventDefault()
  }

  async function copyVersionInfo() {
    try {
      const text = formatVersionInfo(await api().getVersionInfo())
      await navigator.clipboard.writeText(text)
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 2000)
      toast.success('Version info copied')
    } catch (e) {
      toast.error('Could not copy version info', errorInfo(e).message)
    }
  }

  const initials = CREDITS.developer.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
</script>

{#snippet link(url: string, label: string, cls = '')}
  <a href={url} class="rounded-sm text-accent-text underline-offset-2 hover:underline {cls}" onclick={(e) => onLinkClick(e, url)} onauxclick={blockAux} draggable="false">{label}</a>
{/snippet}

<Dialog title="About Slinger" onclose={() => (ui.aboutOpen = false)} size="lg">
  <div class="grid gap-6 pb-1" data-testid="about">
    <!-- 1. Header -->
    <section aria-labelledby="about-name" class="about-hero flex flex-wrap items-center gap-4 rounded-lg border border-border p-4">
      <img src={appIcon} alt="Slinger icon" width="72" height="72" class="h-[72px] w-[72px] shrink-0 rounded-2xl" draggable="false" />
      <div class="min-w-0 flex-1">
        <h3 id="about-name" class="text-2xl font-bold tracking-tight">Slinger</h3>
        <p class="text-sm text-muted">{TAGLINE}</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="rounded-full border border-border bg-raised px-2 py-0.5 font-mono text-xs" data-testid="about-version">
            Version {version ?? '…'}
          </span>
          <Button size="sm" icon={copied ? 'check' : 'copy'} onclick={copyVersionInfo}>{copied ? 'Copied' : 'Copy version info'}</Button>
        </div>
      </div>
    </section>

    <!-- 2. Developer -->
    <section aria-labelledby="about-dev" class="grid gap-3">
      <h3 id="about-dev" class="about-heading">Developer</h3>
      <div class="flex flex-wrap items-center gap-3">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold" aria-hidden="true">{initials}</span>
        <div class="min-w-0">
          <p class="font-semibold">
            {CREDITS.developer.name}
            <span class="font-normal">· {@render link(CREDITS.developer.github, CREDITS.developer.handle)}</span>
          </p>
          <p class="text-sm text-muted">{CREDITS.developer.role}</p>
        </div>
      </div>
      <p class="text-sm text-muted">{CREDITS.aiNote}</p>
      <ul class="flex flex-wrap gap-2" aria-label="Project links">
        {#each CREDITS.links as l (l.url)}
          <li>
            <a
              href={l.url}
              class="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-raised px-3 text-sm hover:bg-hover"
              onclick={(e) => onLinkClick(e, l.url)}
              onauxclick={blockAux}
              draggable="false"
            >
              <Icon name={l.icon} size={14} class="text-accent-text" />
              {l.label}
              <Icon name="external" size={12} class="text-faint" />
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <!-- 3. Inspiration -->
    <section aria-labelledby="about-story" class="grid gap-2">
      <h3 id="about-story" class="about-heading">Why Slinger</h3>
      <blockquote class="grid gap-2 border-l-2 border-accent pl-3 text-sm leading-relaxed">
        {#each INSPIRATION as p, i (i)}<p>{p}</p>{/each}
      </blockquote>
    </section>

    <!-- 4. Manifesto -->
    <section aria-labelledby="about-manifesto" class="grid gap-3">
      <div class="flex items-center gap-2">
        <SlingGlyph kind="sling" size={30} />
        <h3 id="about-manifesto" class="about-heading">The Sling Manifesto</h3>
      </div>
      <ol class="grid gap-x-5 gap-y-3 sm:grid-cols-2" aria-labelledby="about-manifesto">
        {#each MANIFESTO as m, i (m.title)}
          <li class="flex items-start gap-2.5">
            <SlingGlyph kind="stone" n={i + 1} size={30} class="mt-0.5 shrink-0" />
            <p class="text-sm leading-snug">
              <strong class="block font-semibold">{m.title}</strong>
              <span class="text-muted">{m.line}</span>
            </p>
          </li>
        {/each}
      </ol>
      <p class="mt-1 text-center text-sm font-semibold italic text-accent-text" data-testid="about-signoff">{SIGN_OFF}</p>
    </section>

    <!-- 5. Acknowledgements -->
    <section aria-labelledby="about-thanks" class="grid gap-2">
      <h3 id="about-thanks" class="about-heading">Acknowledgements</h3>
      <details class="rounded-lg border border-border">
        <summary class="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-hover">
          <Icon name="chevron-right" size={14} class="about-chevron text-muted transition-transform" />
          <span class="font-medium">Standing on the shoulders of</span>
          <span class="ml-auto text-xs text-faint">{ACKNOWLEDGEMENTS.length} open-source projects</span>
        </summary>
        <div class="grid gap-3 border-t border-border px-3 py-2">
          {#each groups as g (g.id)}
            <div>
              <h4 class="mb-1 text-xs font-semibold text-muted">{g.title}</h4>
              <ul class="grid gap-0.5" aria-label={g.title}>
                {#each g.items as a (a.name)}
                  <li class="flex flex-wrap items-baseline gap-x-2 text-sm" data-testid="ack-item">
                    {@render link(a.homepage, a.name, 'font-medium')}
                    <span class="font-mono text-xs text-faint">{a.version}</span>
                    <span class="rounded bg-raised px-1.5 text-xs text-muted">{a.license}</span>
                    {#if a.description}<span class="min-w-0 basis-full truncate text-xs text-faint sm:basis-auto sm:flex-1">{a.description}</span>{/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
          <p class="text-xs text-faint">
            Plus Chromium and Node.js (inside Electron) and the QuickJS engine by Fabrice Bellard and Charlie Gordon. Full licence texts ship with the
            app in THIRD_PARTY_LICENSES.txt.
          </p>
        </div>
      </details>
    </section>
  </div>

  {#snippet footer()}
    <span class="mr-auto text-xs text-faint">Open source under the MIT License.</span>
    <Button variant="primary" onclick={() => (ui.aboutOpen = false)}>Close</Button>
  {/snippet}
</Dialog>

<style>
  .about-hero {
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, var(--surface)), var(--surface) 70%);
  }
  .about-heading {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  details[open] :global(.about-chevron) {
    transform: rotate(90deg);
  }
  summary {
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
</style>
