<script lang="ts">
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import {
    boolSetting,
    DEFAULT_MAX_REDIRECTS,
    MAX_MAX_REDIRECTS,
    maxRedirectsSetting,
    setBoolSetting,
    setMaxRedirects,
    setStrictSsl,
    strictSslChoice,
    type BoolRequestSetting,
    type StrictSslChoice,
  } from '../../lib/requestSettings'
  import type { RequestTab } from './tabs.svelte'
  let { tab }: { tab: RequestTab } = $props()

  function setTimeout_(v: string) {
    const n = Number(v)
    tab.draft.timeoutMs = v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(n)
  }

  const ppb = $derived(tab.draft.protocolProfileBehavior ?? {})
  const followRedirects = $derived(boolSetting(ppb, 'followRedirects'))

  const REDIRECT_OPTIONS: Array<{ key: BoolRequestSetting; label: string; info: string; needsFollow: boolean }> = [
    {
      key: 'followRedirects',
      label: 'Automatically follow redirects',
      info: 'Follows 301, 302, 303, 307 and 308 responses to their Location. Off: the redirect response itself is shown.',
      needsFollow: false,
    },
    {
      key: 'followOriginalHttpMethod',
      label: 'Follow the original HTTP method',
      info: 'By default a 301 or 302 redirect of a POST, PUT, PATCH or DELETE is followed with GET and no body, as browsers do. On: the method and body are kept. 303 always becomes GET; 307 and 308 always keep the method and body.',
      needsFollow: true,
    },
    {
      key: 'followAuthorizationHeader',
      label: 'Keep the Authorization header on redirects to another site',
      info: 'By default the Authorization header (and an API key header set on the Authorization tab) is not sent on when a redirect leads to another origin (scheme, host or port), so credentials do not leak to another server. An OAuth 2.0 token kept this way is still only sent to origins you allowed.',
      needsFollow: true,
    },
    {
      key: 'removeRefererHeaderOnRedirect',
      label: 'Remove the Referer header on redirects',
      info: 'Drops a Referer header this request sets when a redirect is followed. Slinger never adds a Referer itself.',
      needsFollow: true,
    },
  ]
</script>

<div class="max-w-xl space-y-4 p-3">
  <div class="grid gap-1">
    <label for="req-timeout" class="text-xs text-muted">Request timeout (milliseconds)</label>
    <input id="req-timeout" type="number" min="1" step="100" class="w-48" placeholder="Default" value={tab.draft.timeoutMs ?? ''} oninput={(e) => setTimeout_(e.currentTarget.value)} />
    <p class="text-xs text-faint">Leave empty to use the app default. The request is aborted when the timeout elapses.</p>
  </div>

  <div class="grid gap-1">
    <div class="flex items-center gap-1.5">
      <label for="req-strict-ssl" class="text-xs text-muted">SSL certificate verification</label>
      <InfoTip label="About SSL certificate verification">
        Checks that an https server's certificate is valid for its host name, not expired, and signed by a trusted certificate
        authority. Turn it off for this request to reach a server with a self-signed or otherwise invalid certificate; to trust
        your own certificate authority for every request instead, add it in Settings &gt; Network.
      </InfoTip>
    </div>
    <select id="req-strict-ssl" class="w-64" value={strictSslChoice(ppb)} onchange={(e) => setStrictSsl(tab.draft, e.currentTarget.value as StrictSslChoice)}>
      <option value="default">As in Settings &gt; Network</option>
      <option value="on">On for this request</option>
      <option value="off">Off for this request</option>
    </select>
  </div>

  <fieldset class="grid gap-2">
    <legend class="mb-1 text-xs text-muted">Redirects</legend>
    {#each REDIRECT_OPTIONS as opt (opt.key)}
      <div class="flex items-center gap-1.5 text-sm">
        <label class="flex items-center gap-2" class:opacity-60={opt.needsFollow && !followRedirects}>
          <input
            type="checkbox"
            data-testid="req-setting-{opt.key}"
            checked={boolSetting(ppb, opt.key)}
            disabled={opt.needsFollow && !followRedirects}
            onchange={(e) => setBoolSetting(tab.draft, opt.key, e.currentTarget.checked)}
          />
          {opt.label}
        </label>
        <InfoTip label="About: {opt.label}">{opt.info}</InfoTip>
      </div>
    {/each}
    <div class="flex items-center gap-2 text-sm">
      <label for="req-max-redirects" class:opacity-60={!followRedirects}>Maximum number of redirects</label>
      <input
        id="req-max-redirects"
        type="number"
        min="0"
        max={MAX_MAX_REDIRECTS}
        step="1"
        class="w-24"
        placeholder={String(DEFAULT_MAX_REDIRECTS)}
        disabled={!followRedirects}
        value={maxRedirectsSetting(ppb) ?? ''}
        onchange={(e) => setMaxRedirects(tab.draft, e.currentTarget.value)}
      />
      <InfoTip label="About the maximum number of redirects">
        The request fails with "Too many redirects" when it would follow more than this (default {DEFAULT_MAX_REDIRECTS}), which ends
        redirect loops.
      </InfoTip>
    </div>
  </fieldset>
  <div class="flex items-center gap-1">
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={boolSetting(ppb, 'disableCookies')} onchange={(e) => setBoolSetting(tab.draft, 'disableCookies', e.currentTarget.checked)} />
      Disable cookie jar
    </label>
    <InfoTip label="About the cookie jar">
      Normally a request sends the workspace's stored cookies for its URL and keeps the cookies its response sets (like a
      browser). With this on, it does neither. Manage stored cookies with Ctrl+K, Cookies.
    </InfoTip>
  </div>
</div>
