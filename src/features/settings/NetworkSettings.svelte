<script lang="ts">
  /**
   * Settings > Network: SSL certificate verification, extra CA certificates, client certificates per host and the proxy.
   * Everything is stored in the main process (app-wide, this computer only); passwords and passphrases go to the OS keychain
   * and never come back (only `hasPassword` / `hasPassphrase`).
   */
  import { onMount } from 'svelte'
  import type { NetworkClientCertificate, NetworkSettings, ProxyMode } from '../../../shared/types'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'

  let settings = $state<NetworkSettings | null>(null)
  let loadError = $state<string | null>(null)
  let busy = $state(false)

  onMount(() => {
    api()
      .getNetworkSettings()
      .then(
        (s) => {
          settings = s
          resetProxyForm(s)
        },
        (e) => (loadError = errorInfo(e).message),
      )
  })

  /** Runs one settings change; the returned settings replace the shown ones. Failures are toasts; returns success. */
  async function apply(title: string, fn: () => Promise<NetworkSettings>): Promise<boolean> {
    busy = true
    try {
      settings = await fn()
      return true
    } catch (e) {
      toast.error(title, errorInfo(e).message)
      return false
    } finally {
      busy = false
    }
  }

  const fileName = (path: string | null) => (path ? (path.split(/[\\/]/).pop() ?? path) : '')
  const formatDate = (unix: number) => new Date(unix * 1000).toLocaleDateString()
  const expired = (unix: number) => unix * 1000 < Date.now()

  // ---- CA certificates ----
  async function addCa() {
    const path = await api().pickFile({ title: 'Choose a CA certificate (PEM or DER)', filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'der'] }, { name: 'All files', extensions: ['*'] }] })
    if (!path) return
    if (await apply('Could not add the CA certificate', () => api().addNetworkCaCertificates([path]))) toast.success('CA certificate added')
  }

  // ---- client certificates ----
  interface CertForm {
    id?: string
    host: string
    port: string
    kind: 'pem' | 'pfx'
    crtPath: string | null
    keyPath: string | null
    pfxPath: string | null
    passphrase: string
    hasPassphrase: boolean
    clearPassphrase: boolean
  }
  let certForm = $state<CertForm | null>(null)
  let certError = $state<string | null>(null)

  function editCert(c?: NetworkClientCertificate) {
    certError = null
    certForm = c
      ? {
          id: c.id,
          host: c.host,
          port: c.port === null ? '' : String(c.port),
          kind: c.pfxPath ? 'pfx' : 'pem',
          crtPath: c.crtPath,
          keyPath: c.keyPath,
          pfxPath: c.pfxPath,
          passphrase: '',
          hasPassphrase: c.hasPassphrase,
          clearPassphrase: false,
        }
      : { host: '', port: '', kind: 'pem', crtPath: null, keyPath: null, pfxPath: null, passphrase: '', hasPassphrase: false, clearPassphrase: false }
  }

  async function chooseCertFile(field: 'crtPath' | 'keyPath' | 'pfxPath') {
    if (!certForm) return
    const titles = { crtPath: 'Choose the certificate file (PEM)', keyPath: 'Choose the private key file (PEM)', pfxPath: 'Choose the PFX / PKCS#12 file' }
    const extensions = { crtPath: ['crt', 'pem', 'cer'], keyPath: ['key', 'pem'], pfxPath: ['pfx', 'p12'] }
    const path = await api().pickFile({ title: titles[field], defaultPath: certForm[field] ?? undefined, filters: [{ name: 'Certificate files', extensions: extensions[field] }, { name: 'All files', extensions: ['*'] }] })
    if (path && certForm) certForm[field] = path
  }

  async function saveCert() {
    const f = certForm
    if (!f) return
    const port = f.port.trim() === '' ? null : Number(f.port)
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      certError = 'The port must be a number from 1 to 65535, or empty for any port.'
      return
    }
    certError = null
    busy = true
    try {
      settings = await api().saveNetworkClientCertificate({
        ...(f.id ? { id: f.id } : {}),
        host: f.host,
        port,
        crtPath: f.kind === 'pem' ? f.crtPath : null,
        keyPath: f.kind === 'pem' ? f.keyPath : null,
        pfxPath: f.kind === 'pfx' ? f.pfxPath : null,
        ...(f.passphrase ? { passphrase: f.passphrase } : f.clearPassphrase ? { passphrase: null } : {}),
      })
      certForm = null
    } catch (e) {
      certError = errorInfo(e).message
    } finally {
      busy = false
    }
  }

  // ---- proxy ----
  let proxyUrl = $state('')
  let proxyUser = $state('')
  let proxyPassword = $state('')
  let proxyBypass = $state('')
  let proxyError = $state<string | null>(null)
  /** Custom chosen but not saved yet (no proxy URL stored). */
  let customPending = $state(false)

  function resetProxyForm(s: NetworkSettings) {
    proxyUrl = s.proxy.url
    proxyUser = s.proxy.username
    proxyPassword = ''
    proxyBypass = s.proxy.bypass.join(', ')
  }

  const mode = $derived<ProxyMode | null>(customPending ? 'custom' : (settings?.proxy.mode ?? null))
  const bypassList = () =>
    proxyBypass
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter(Boolean)

  async function setMode(next: ProxyMode) {
    proxyError = null
    if (next === 'custom' && !settings?.proxy.url) {
      customPending = true
      return
    }
    customPending = false
    await apply('Could not change the proxy', () => api().setNetworkSettings({ proxy: { mode: next } }))
  }

  async function saveProxy() {
    proxyError = null
    busy = true
    try {
      settings = await api().setNetworkSettings({
        proxy: {
          mode: 'custom',
          url: proxyUrl,
          username: proxyUser,
          bypass: bypassList(),
          // No username: no authentication, so a stored password goes too.
          ...(proxyPassword && proxyUser.trim() ? { password: proxyPassword } : !proxyUser.trim() ? { password: null } : {}),
        },
      })
      customPending = false
      resetProxyForm(settings)
      toast.success('Proxy saved')
    } catch (e) {
      proxyError = errorInfo(e).message
    } finally {
      busy = false
    }
  }

  const proxyDirty = $derived(
    !!settings &&
      (customPending ||
        proxyUrl !== settings.proxy.url ||
        proxyUser !== settings.proxy.username ||
        proxyPassword !== '' ||
        bypassList().join(',') !== settings.proxy.bypass.join(',')),
  )
</script>

<div class="grid gap-6" data-testid="network-settings">
  {#if loadError}
    <InlineError message={`Could not load the network settings: ${loadError}`} />
  {:else if !settings}
    <p class="text-sm text-muted">Loading…</p>
  {:else}
    <section class="grid gap-2" aria-labelledby="ssl-heading">
      <h3 class="text-sm font-semibold" id="ssl-heading">Certificates</h3>
      <div class="flex items-center gap-1.5 text-sm">
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="verify-ssl"
            checked={settings.verifySsl}
            disabled={busy}
            onchange={(e) => void apply('Could not change SSL verification', () => api().setNetworkSettings({ verifySsl: e.currentTarget.checked }))}
          />
          SSL certificate verification
        </label>
        <InfoTip label="About SSL certificate verification">
          Checks that every https server's certificate is valid for its host name, not expired, and signed by a trusted certificate
          authority (the ones built into Slinger plus the CA certificates below). Turning it off accepts any certificate, which lets
          anyone between you and the server read and change the traffic; prefer adding your CA certificate, or turn verification off
          for a single request on its Settings tab, which also overrides this setting.
        </InfoTip>
      </div>

      <div class="mt-2 flex items-center gap-1.5">
        <h4 class="text-xs font-semibold text-muted">CA certificates</h4>
        <InfoTip label="About CA certificates">
          Certificate authorities to trust in addition to the built-in ones, for servers whose certificates your company or your
          development tools issue. PEM files may hold several certificates; each is added. Only the public certificates are stored.
        </InfoTip>
      </div>
      {#if settings.caCertificates.length === 0}
        <p class="text-xs text-faint">None added.</p>
      {:else}
        <ul class="grid gap-1 text-sm" aria-label="CA certificates">
          {#each settings.caCertificates as c (c.id)}
            <li class="flex items-center gap-2 rounded border border-border px-2 py-1">
              <span class="min-w-0 flex-1 truncate" title={c.name}><span class="font-medium">{c.subject}</span> <span class="text-xs text-faint">{c.name}</span></span>
              <span class="text-xs {expired(c.expiresAt) ? 'text-danger' : 'text-faint'}">{expired(c.expiresAt) ? 'expired' : 'until'} {formatDate(c.expiresAt)}</span>
              <Button size="sm" variant="ghost" icon="trash" aria-label="Remove {c.subject}" disabled={busy} onclick={() => void apply('Could not remove the CA certificate', () => api().removeNetworkCaCertificate(c.id))}>Remove</Button>
            </li>
          {/each}
        </ul>
      {/if}
      <div><Button size="sm" icon="plus" disabled={busy} onclick={() => void addCa()} data-testid="add-ca">Add CA certificate…</Button></div>

      <div class="mt-2 flex items-center gap-1.5">
        <h4 class="text-xs font-semibold text-muted">Client certificates</h4>
        <InfoTip label="About client certificates">
          Sent to https servers that ask for one (mutual TLS), chosen by the request's host and, if given, port. Use a PEM certificate
          with its key file, or a PFX / PKCS#12 file. Slinger remembers where the files are and reads them when a request needs them;
          a passphrase is kept in the system keychain.
        </InfoTip>
      </div>
      {#if settings.clientCertificates.length === 0}
        {#if !certForm}<p class="text-xs text-faint">None added.</p>{/if}
      {:else}
        <ul class="grid gap-1 text-sm" aria-label="Client certificates">
          {#each settings.clientCertificates as c (c.id)}
            <li class="flex items-center gap-2 rounded border border-border px-2 py-1">
              <span class="min-w-0 flex-1 truncate">
                <span class="font-medium">{c.host}{c.port !== null ? `:${c.port}` : ''}</span>
                <span class="text-xs text-faint">{c.pfxPath ? fileName(c.pfxPath) : `${fileName(c.crtPath)} + ${fileName(c.keyPath)}`}{c.hasPassphrase ? ' · passphrase stored' : ''}</span>
              </span>
              <Button size="sm" variant="ghost" icon="edit" aria-label="Edit {c.host}" disabled={busy} onclick={() => editCert(c)}>Edit</Button>
              <Button size="sm" variant="ghost" icon="trash" aria-label="Remove {c.host}" disabled={busy} onclick={() => void apply('Could not remove the client certificate', () => api().removeNetworkClientCertificate(c.id))}>Remove</Button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if certForm}
        <form class="grid gap-2 rounded border border-border p-3 text-sm" aria-label="Client certificate" onsubmit={(e) => (e.preventDefault(), void saveCert())}>
          <div class="flex flex-wrap items-end gap-2">
            <label class="grid gap-1">
              <span class="text-xs text-muted">Host</span>
              <input type="text" class="w-64" placeholder="api.example.com or *.example.com" bind:value={certForm.host} data-testid="cert-host" />
            </label>
            <label class="grid gap-1">
              <span class="text-xs text-muted">Port (optional)</span>
              <input type="text" class="w-24" inputmode="numeric" placeholder="Any" bind:value={certForm.port} data-testid="cert-port" />
            </label>
          </div>
          <div role="radiogroup" aria-label="Certificate format" class="flex items-center gap-4">
            <label class="flex items-center gap-2"><input type="radio" name="cert-kind" value="pem" bind:group={certForm.kind} /> Certificate + key (PEM)</label>
            <label class="flex items-center gap-2"><input type="radio" name="cert-kind" value="pfx" bind:group={certForm.kind} /> PFX / PKCS#12</label>
          </div>
          {#if certForm.kind === 'pem'}
            <div class="flex items-center gap-2">
              <Button size="sm" onclick={() => void chooseCertFile('crtPath')} data-testid="cert-choose-crt">Certificate file…</Button>
              <span class="truncate text-xs text-muted">{fileName(certForm.crtPath) || 'None chosen'}</span>
            </div>
            <div class="flex items-center gap-2">
              <Button size="sm" onclick={() => void chooseCertFile('keyPath')} data-testid="cert-choose-key">Key file…</Button>
              <span class="truncate text-xs text-muted">{fileName(certForm.keyPath) || 'None chosen'}</span>
            </div>
          {:else}
            <div class="flex items-center gap-2">
              <Button size="sm" onclick={() => void chooseCertFile('pfxPath')} data-testid="cert-choose-pfx">PFX file…</Button>
              <span class="truncate text-xs text-muted">{fileName(certForm.pfxPath) || 'None chosen'}</span>
            </div>
          {/if}
          <div class="flex flex-wrap items-center gap-2">
            <label class="grid gap-1">
              <span class="text-xs text-muted">Passphrase (optional)</span>
              <input
                type="password"
                class="w-64"
                autocomplete="off"
                placeholder={certForm.hasPassphrase && !certForm.clearPassphrase ? 'Stored; type to replace' : ''}
                disabled={certForm.clearPassphrase}
                bind:value={certForm.passphrase}
                data-testid="cert-passphrase"
              />
            </label>
            {#if certForm.hasPassphrase}
              <label class="mt-4 flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={certForm.clearPassphrase} /> Remove the stored passphrase</label>
            {/if}
          </div>
          <InlineError message={certError} />
          <div class="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy} data-testid="cert-save">{certForm.id ? 'Save' : 'Add'}</Button>
            <Button size="sm" onclick={() => (certForm = null)}>Cancel</Button>
          </div>
        </form>
      {:else}
        <div><Button size="sm" icon="plus" disabled={busy} onclick={() => editCert()} data-testid="add-client-cert">Add client certificate…</Button></div>
      {/if}
    </section>

    <section class="grid gap-2" aria-labelledby="proxy-heading">
      <div class="flex items-center gap-1.5">
        <h3 class="text-sm font-semibold" id="proxy-heading">Proxy</h3>
        <InfoTip label="About the proxy">
          Used for your requests, collection runs, workflows, assistants' requests, scripts' pm.sendRequest, OAuth 2.0 token
          requests and OpenAPI imports by URL. The system proxy is the one set in your operating system or desktop (including
          automatic configuration scripts). Requests to this computer (localhost, 127.0.0.1), such as mock servers, never go through
          a proxy. Cloud sync and update checks always use the system proxy.
        </InfoTip>
      </div>
      <div role="radiogroup" aria-label="Proxy" class="grid gap-1.5 text-sm">
        <label class="flex items-center gap-2"><input type="radio" name="proxy-mode" value="system" checked={mode === 'system'} disabled={busy} onchange={() => void setMode('system')} /> Use the system proxy</label>
        <label class="flex items-center gap-2"><input type="radio" name="proxy-mode" value="custom" checked={mode === 'custom'} disabled={busy} onchange={() => void setMode('custom')} /> Custom proxy</label>
        <label class="flex items-center gap-2"><input type="radio" name="proxy-mode" value="none" checked={mode === 'none'} disabled={busy} onchange={() => void setMode('none')} /> No proxy</label>
      </div>
      {#if mode === 'custom'}
        <form class="grid gap-2 rounded border border-border p-3 text-sm" aria-label="Custom proxy" onsubmit={(e) => (e.preventDefault(), void saveProxy())}>
          <label class="grid gap-1">
            <span class="text-xs text-muted">Proxy URL</span>
            <input type="text" class="w-80" placeholder="http://proxy.example.com:3128" bind:value={proxyUrl} data-testid="proxy-url" />
          </label>
          <div class="flex flex-wrap gap-2">
            <label class="grid gap-1">
              <span class="text-xs text-muted">Username (optional)</span>
              <input type="text" class="w-48" autocomplete="off" bind:value={proxyUser} data-testid="proxy-username" />
            </label>
            <label class="grid gap-1">
              <span class="text-xs text-muted">Password</span>
              <input
                type="password"
                class="w-48"
                autocomplete="off"
                placeholder={settings.proxy.hasPassword ? 'Stored; type to replace' : ''}
                bind:value={proxyPassword}
                data-testid="proxy-password"
              />
            </label>
          </div>
          <label class="grid gap-1">
            <span class="flex items-center gap-1.5 text-xs text-muted">
              Bypass the proxy for
              <InfoTip label="About the bypass list">
                Host names separated by commas: <code>example.com</code> (that host), <code>.example.com</code> or
                <code>*.example.com</code> (the domain and its subdomains), optionally with <code>:port</code>; <code>*</code> for
                every host.
              </InfoTip>
            </span>
            <input type="text" class="w-80" placeholder="internal.example.com, .corp" bind:value={proxyBypass} data-testid="proxy-bypass" />
          </label>
          <InlineError message={proxyError} />
          <div><Button type="submit" size="sm" variant="primary" disabled={busy || !proxyDirty} data-testid="proxy-save">Save proxy</Button></div>
        </form>
      {/if}
    </section>
  {/if}
</div>
