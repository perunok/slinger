<script lang="ts">
  /**
   * The Cookies manager (0.29): the open workspace's cookie jar, by domain. Values are masked until revealed (main keeps
   * them encrypted; `revealCookie` reads one). Add, edit, delete one cookie, delete a domain's cookies, clear all, search,
   * and the domains pm.cookies.jar() may use in scripts.
   */
  import { onMount } from 'svelte'
  import type { JarCookie } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { expiryText, flagsText, formInput, formOf, groupCookies, newForm, parseDomainList, type CookieForm } from './cookieView'

  const workspaceId = app.workspaceId
  let cookies = $state<JarCookie[]>([])
  let loaded = $state(false)
  let loadError = $state<string | null>(null)
  let query = $state('')
  /** Revealed values by cookie id (in memory while the dialog is open). */
  let revealed = $state<Record<string, string>>({})
  let form = $state<CookieForm | null>(null)
  let formError = $state<string | null>(null)
  let saving = $state(false)
  let confirm = $state<{ domain: string | null } | null>(null)
  let domainsText = $state('')
  let domainsSaved = $state('')
  let domainsError = $state<string | null>(null)

  const groups = $derived(groupCookies(cookies, query))

  async function load() {
    if (!workspaceId) return
    try {
      cookies = await api().listCookies(workspaceId)
      loadError = null
    } catch (e) {
      loadError = errorInfo(e).message
    } finally {
      loaded = true
    }
  }

  onMount(() => {
    void load()
    if (workspaceId) {
      api()
        .getCookieScriptDomains(workspaceId)
        .then((list) => (domainsText = domainsSaved = list.join('\n')))
        .catch((e) => (domainsError = errorInfo(e).message))
    }
  })

  async function toggleReveal(c: JarCookie) {
    if (revealed[c.id] !== undefined) {
      const { [c.id]: _gone, ...rest } = revealed
      revealed = rest
      return
    }
    try {
      revealed = { ...revealed, [c.id]: await api().revealCookie(c.id) }
    } catch (e) {
      toast.error('Could not read the cookie', errorInfo(e).message)
    }
  }

  function edit(c: JarCookie) {
    formError = null
    form = formOf(c)
    if (revealed[c.id] !== undefined) form.value = revealed[c.id]!
  }

  async function revealInForm() {
    if (!form?.id) return
    try {
      form.value = await api().revealCookie(form.id)
    } catch (e) {
      formError = errorInfo(e).message
    }
  }

  async function save() {
    if (!form || !workspaceId) return
    saving = true
    formError = null
    try {
      const saved = await api().upsertCookie(formInput(workspaceId, form))
      if (form.value !== null) revealed = { ...revealed, [saved.id]: form.value }
      form = null
      await load()
    } catch (e) {
      formError = errorInfo(e).message
    } finally {
      saving = false
    }
  }

  async function remove(c: JarCookie) {
    try {
      await api().deleteCookie(c.id)
      if (form?.id === c.id) form = null
      await load()
    } catch (e) {
      toast.error('Could not delete the cookie', errorInfo(e).message)
    }
  }

  async function clear(domain: string | null) {
    if (!workspaceId) return
    await api().clearCookies(workspaceId, domain)
    form = null
    await load()
  }

  async function saveDomains() {
    if (!workspaceId) return
    domainsError = null
    try {
      const list = await api().setCookieScriptDomains(workspaceId, parseDomainList(domainsText))
      domainsText = domainsSaved = list.join('\n')
    } catch (e) {
      domainsError = errorInfo(e).message
    }
  }
</script>

<Dialog title="Cookies" onclose={() => (ui.cookiesOpen = false)} size="lg">
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <input type="search" class="h-8 min-w-0 flex-1" placeholder="Search by domain, name or path" aria-label="Search cookies" bind:value={query} />
      <Button size="md" icon="plus" onclick={() => ((formError = null), (form = newForm()))}>Add cookie</Button>
      <Button size="md" variant="ghost" icon="trash" disabled={cookies.length === 0} onclick={() => (confirm = { domain: null })}>Clear all</Button>
      <InfoTip label="About the cookie jar">
        Requests in this workspace send the cookies stored here for their URL and keep the cookies their responses set,
        like a browser (the collection runner, workflows and pm.sendRequest included). A request's Settings tab can turn
        this off. Values are stored encrypted and never synced or exported. AI assistants' own requests do not use them.
      </InfoTip>
    </div>

    {#if form}
      {@const f = form}
      <form
        class="space-y-2 rounded border border-border p-3"
        aria-label={f.id ? 'Edit cookie' : 'Add cookie'}
        onsubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div class="grid grid-cols-2 gap-2">
          <label class="grid gap-1 text-xs text-muted">Name<input class="h-7 font-mono" bind:value={f.name} required /></label>
          <label class="grid gap-1 text-xs text-muted">
            Value
            <span class="flex items-center gap-1">
              {#if f.value === null}
                <input class="h-7 min-w-0 flex-1 font-mono" placeholder="•••••••• (unchanged)" aria-label="Value" oninput={(e) => (f.value = e.currentTarget.value)} />
                <IconButton icon="eye" label="Reveal value" onclick={revealInForm} />
              {:else}
                <input class="h-7 min-w-0 flex-1 font-mono" aria-label="Value" bind:value={f.value} />
              {/if}
            </span>
          </label>
          <label class="grid gap-1 text-xs text-muted">Domain<input class="h-7 font-mono" bind:value={f.domain} placeholder="api.example.com" required /></label>
          <label class="grid gap-1 text-xs text-muted">Path<input class="h-7 font-mono" bind:value={f.path} placeholder="/" /></label>
          <label class="grid gap-1 text-xs text-muted">Expires (empty: session)<input type="datetime-local" class="h-7" bind:value={f.expires} /></label>
          <label class="grid gap-1 text-xs text-muted">
            SameSite
            <select class="h-7" bind:value={f.sameSite}>
              <option value="">Not set</option>
              <option value="Lax">Lax</option>
              <option value="Strict">Strict</option>
              <option value="None">None</option>
            </select>
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-4 text-sm">
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={f.subdomains} />Include subdomains</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={f.secure} />Secure (https and localhost only)</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={f.httpOnly} />HttpOnly</label>
        </div>
        {#if formError}<InlineError message={formError} />{/if}
        <div class="flex justify-end gap-2">
          <Button onclick={() => (form = null)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>{f.id ? 'Save' : 'Add'}</Button>
        </div>
      </form>
    {/if}

    {#if loadError}
      <InlineError message={loadError} />
    {:else if loaded && cookies.length === 0}
      <p class="py-4 text-center text-sm text-muted">No cookies yet. Responses that set cookies add them here.</p>
    {:else if loaded && groups.length === 0}
      <p class="py-4 text-center text-sm text-muted">No cookie matches “{query}”.</p>
    {/if}

    <div class="max-h-[50vh] space-y-3 overflow-auto">
      {#each groups as g (g.domain)}
        <section aria-label="Cookies of {g.domain}" class="rounded border border-border">
          <header class="flex items-center gap-2 border-b border-border bg-raised px-2 py-1">
            <span class="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{g.domain}</span>
            <span class="text-xs text-faint">{g.cookies.length}</span>
            <IconButton icon="trash" label="Delete the cookies of {g.domain}" onclick={() => (confirm = { domain: g.domain })} />
          </header>
          <table class="w-full table-fixed border-collapse text-xs">
            <colgroup><col class="w-[20%]" /><col class="w-[26%]" /><col class="w-[12%]" /><col class="w-[18%]" /><col /><col class="w-20" /></colgroup>
            <thead class="text-left text-faint">
              <tr>
                {#each ['Name', 'Value', 'Path', 'Expires', 'Flags', ''] as h (h)}<th class="px-2 py-1 font-normal">{h}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each g.cookies as c (c.id)}
                {@const shown = revealed[c.id]}
                <tr class="border-t border-border align-middle font-mono" data-testid="cookie-row">
                  <td class="break-all px-2 py-1 font-semibold">{c.name}</td>
                  <td class="px-2 py-1">
                    <span class="flex items-center gap-1">
                      <span class="min-w-0 flex-1 break-all" data-testid="cookie-value">{shown ?? '••••••••'}</span>
                      <IconButton icon={shown !== undefined ? 'eye-off' : 'eye'} label="{shown !== undefined ? 'Hide' : 'Reveal'} value of {c.name}" onclick={() => toggleReveal(c)} />
                    </span>
                  </td>
                  <td class="break-all px-2 py-1">{c.path}</td>
                  <td class="px-2 py-1">{expiryText(c.expiresAt)}</td>
                  <td class="px-2 py-1 font-sans">{flagsText(c)}</td>
                  <td class="whitespace-nowrap px-1 py-1 text-right">
                    <IconButton icon="edit" label="Edit {c.name}" onclick={() => edit(c)} />
                    <IconButton icon="trash" label="Delete {c.name}" onclick={() => remove(c)} />
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/each}
    </div>

    <section class="space-y-1 border-t border-border pt-3" aria-label="Script access to cookies">
      <div class="flex items-center gap-1">
        <label for="cookie-script-domains" class="text-sm font-medium">Domains scripts may access</label>
        <InfoTip label="About script access to cookies">
          pm.cookies.jar() in pre-request and test scripts can read and change the cookies of these domains (and their
          subdomains) only; for any other domain it fails. Empty: scripts cannot use the jar. One domain per line.
        </InfoTip>
      </div>
      <textarea id="cookie-script-domains" class="h-16 w-full font-mono text-xs" placeholder="api.example.com" bind:value={domainsText}></textarea>
      {#if domainsError}<InlineError message={domainsError} />{/if}
      <div class="flex justify-end">
        <Button size="sm" disabled={domainsText === domainsSaved} onclick={saveDomains}>Save domains</Button>
      </div>
    </section>
  </div>
</Dialog>

{#if confirm}
  {@const domain = confirm.domain}
  <ConfirmDialog
    title={domain ? `Delete the cookies of ${domain}?` : 'Delete all cookies?'}
    message={domain ? `Every cookie stored for ${domain} in this workspace is deleted.` : 'Every cookie of this workspace is deleted. Sessions they held are lost.'}
    confirmLabel="Delete"
    danger
    onconfirm={() => clear(domain)}
    oncancel={() => (confirm = null)}
  />
{/if}
