<script lang="ts">
  /**
   * Auth settings editor, shared by a request's Authorization tab and a collection's / folder's Authorization section.
   * `level` decides which types exist: requests and folders can inherit from their parent (Postman's default), a
   * collection is the top and cannot. While inheriting, `inherited` (the resolved auth and where it comes from) is shown
   * read-only; `onopensource` opens that folder / collection to edit it.
   */
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import OAuth2Panel from '../oauth2/OAuth2Panel.svelte'
  import { AUTH_KIND_LABELS, authKindLabel, type AuthSource, type EffectiveAuth } from '../../lib/authInheritance'
  import { awsV4Of, digestOf, emptyAwsV4, emptyDigest, type AuthDraft, type AuthKind, type AwsV4Draft, type DigestDraft } from '../../lib/request'

  interface Props {
    auth: AuthDraft
    level: 'request' | 'folder' | 'collection'
    /** Whose collection variables resolve OAuth 2.0 settings. */
    collectionId: string | null
    /** What `inherit` resolves to here (requests and folders). */
    inherited?: EffectiveAuth | null
    onopensource?: (source: AuthSource) => void
    readOnly?: boolean
  }
  let { auth = $bindable(), level, collectionId, inherited = null, onopensource, readOnly = false }: Props = $props()
  const a = $derived(auth)
  let reveal = $state(false)

  const KINDS = $derived(
    (['inherit', 'none', 'basic', 'bearer', 'apiKey', 'digest', 'awsv4', 'oauth2'] as AuthKind[])
      .filter((k) => k !== 'inherit' || level !== 'collection')
      .map((id) => ({ id, label: AUTH_KIND_LABELS[id] })),
  )
  const subject = $derived(level === 'request' ? 'This request' : `This ${level}`)

  // Digest / AWS Signature (0.30): drafts from an older Slinger may lack these objects, so they are read through
  // digestOf / awsV4Of and written as a whole (stored entries kept).
  const dg = $derived(digestOf(a))
  const aws = $derived(awsV4Of(a))
  const setDigest = <K extends keyof DigestDraft>(k: K, v: DigestDraft[K]) => (auth.digest = { ...digestOf(auth), [k]: v })
  const setAws = <K extends keyof AwsV4Draft>(k: K, v: AwsV4Draft[K]) => (auth.awsv4 = { ...awsV4Of(auth), [k]: v })
  const DIGEST_ALGORITHMS = ['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess', 'SHA-512-256', 'SHA-512-256-sess']

  function setKind(kind: AuthKind) {
    auth.kind = kind
    if (kind === 'digest' && !auth.digest) auth.digest = emptyDigest()
    if (kind === 'awsv4' && !auth.awsv4) auth.awsv4 = emptyAwsV4()
  }
</script>

<div class="max-w-xl space-y-3 p-3" data-testid="auth-editor-{level}">
  <div class="grid gap-1">
    <label for="auth-kind-{level}" class="text-xs text-muted">Authorization type</label>
    <select id="auth-kind-{level}" class="w-56" value={a.kind} disabled={readOnly} onchange={(e) => setKind(e.currentTarget.value as AuthKind)}>
      {#each KINDS as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
      {#if a.kind === 'unsupported'}<option value="unsupported">{a.unsupportedType ?? 'Custom'} (unsupported)</option>{/if}
    </select>
  </div>

  {#snippet field(label: string, value: string, set: (v: string) => void, opts: { secret?: boolean; placeholder?: string } = {})}
    <div class="grid gap-1">
      <span class="text-xs text-muted">{label}</span>
      <div class="flex items-center gap-1">
        <div class="min-w-0 flex-1 rounded border border-border bg-surface px-1 py-0.5 focus-within:border-accent">
          <TemplateInput class="w-full !border-transparent" {label} {value} oninput={set} masked={!!opts.secret && !reveal} placeholder={opts.placeholder ?? ''} />
        </div>
        {#if opts.secret}
          <IconButton icon={reveal ? 'eye-off' : 'eye'} label={reveal ? 'Hide secret values' : 'Show secret values'} active={reveal} onclick={() => (reveal = !reveal)} />
        {/if}
      </div>
    </div>
  {/snippet}

  {#if a.kind === 'inherit'}
    <div class="flex flex-wrap items-center gap-1.5 text-sm" data-testid="auth-inherited">
      {#if inherited?.source}
        <span>Inherited from</span>
        {#if onopensource}
          <button type="button" class="truncate rounded px-1 font-medium hover:bg-hover hover:text-fg" onclick={() => onopensource(inherited.source!)}
            >{inherited.source.name}</button
          >
        {:else}
          <strong class="truncate">{inherited.source.name}</strong>
        {/if}
        <span class="text-muted">({inherited.source.kind}):</span>
        <strong data-testid="auth-inherited-kind">{authKindLabel(inherited.auth)}</strong>
      {:else}
        <span class="text-muted" data-testid="auth-inherited-kind">{level === 'request' ? 'Not in a collection: sent without authorization.' : 'No auth'}</span>
      {/if}
      <InfoTip label="About inherited authorization">
        {subject} uses the authorization of the nearest folder above it that sets one, else the collection's, as in Postman.
        It is looked up when the request is sent, so changing it on the folder or collection changes every request that
        inherits it.{#if inherited?.auth.kind === 'oauth2'} Get the OAuth 2.0 token in that {inherited.source?.kind ?? 'collection'}'s
          Authorization section; requests that inherit the same settings share it.{/if}
      </InfoTip>
    </div>
  {:else if a.kind === 'basic'}
    {@render field('Username', a.basic.username, (v) => (auth.basic.username = v))}
    {@render field('Password', a.basic.password, (v) => (auth.basic.password = v), { secret: true })}
  {:else if a.kind === 'bearer'}
    {@render field('Token', a.bearer.token, (v) => (auth.bearer.token = v), { secret: true, placeholder: 'Token or {{variable}}' })}
  {:else if a.kind === 'apiKey'}
    {@render field('Key', a.apiKey.key, (v) => (auth.apiKey.key = v), { placeholder: 'X-API-Key' })}
    {@render field('Value', a.apiKey.value, (v) => (auth.apiKey.value = v), { secret: true })}
    <div class="grid gap-1">
      <label for="auth-addto-{level}" class="text-xs text-muted">Add to</label>
      <select id="auth-addto-{level}" class="w-56" value={a.apiKey.addTo} onchange={(e) => (auth.apiKey.addTo = e.currentTarget.value === 'query' ? 'query' : 'header')}>
        <option value="header">Header</option>
        <option value="query">Query parameter</option>
      </select>
    </div>
  {:else if a.kind === 'digest'}
    <div class="flex items-center gap-1.5 text-sm text-muted" data-testid="digest-editor">
      <span>The server's challenge is answered when the request is sent.</span>
      <InfoTip label="About Digest auth">
        Slinger sends the request; when the server answers <code>401</code> with a <code>WWW-Authenticate: Digest</code> challenge, it
        computes the answer from the user name and password (MD5, SHA-256 or SHA-512-256, with or without <code>-sess</code>; qop
        <code>auth</code> or <code>auth-int</code>) and sends the request once more, also after a redirect. The response's Headers tab
        says that Digest was used. The password is never sent itself.
      </InfoTip>
    </div>
    {@render field('Username', dg.username, (v) => setDigest('username', v))}
    {@render field('Password', dg.password, (v) => setDigest('password', v), { secret: true })}
    <details class="rounded border border-border px-2.5 py-1.5" data-testid="digest-advanced">
      <summary class="cursor-pointer text-xs text-muted">Advanced</summary>
      <div class="mt-2 space-y-3 pb-1">
        <div class="flex items-center gap-1">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" data-testid="digest-disable-retry" checked={dg.disableRetryRequest} onchange={(e) => setDigest('disableRetryRequest', e.currentTarget.checked)} />
            Do not answer the challenge automatically
          </label>
          <InfoTip label="About answering the challenge">
            Off (the default): a <code>401</code> challenge is answered by sending the request again. On: the request is sent once, with
            the header computed from the realm and nonce below (when both are set), as Postman's "Disable retrying the request" does.
          </InfoTip>
        </div>
        <p class="text-[11px] text-faint">
          Optional. With a realm and a nonce the first request already carries the Authorization header; the server's challenge
          replaces these values.
        </p>
        {@render field('Realm', dg.realm, (v) => setDigest('realm', v), { placeholder: 'testrealm@example.com' })}
        {@render field('Nonce', dg.nonce, (v) => setDigest('nonce', v))}
        <div class="grid gap-1">
          <label for="digest-algorithm-{level}" class="text-xs text-muted">Algorithm</label>
          <select id="digest-algorithm-{level}" class="w-56" value={dg.algorithm || 'MD5'} onchange={(e) => setDigest('algorithm', e.currentTarget.value)}>
            {#each DIGEST_ALGORITHMS as alg (alg)}<option value={alg}>{alg}</option>{/each}
            {#if dg.algorithm && !DIGEST_ALGORITHMS.includes(dg.algorithm)}<option value={dg.algorithm}>{dg.algorithm}</option>{/if}
          </select>
        </div>
        {@render field('qop', dg.qop, (v) => setDigest('qop', v), { placeholder: 'auth or auth-int' })}
        {@render field('Nonce count', dg.nonceCount, (v) => setDigest('nonceCount', v), { placeholder: '00000001' })}
        {@render field('Client nonce', dg.clientNonce, (v) => setDigest('clientNonce', v), { placeholder: 'Random when empty' })}
        {@render field('Opaque', dg.opaque, (v) => setDigest('opaque', v))}
      </div>
    </details>
  {:else if a.kind === 'awsv4'}
    <div class="flex items-center gap-1.5 text-sm text-muted" data-testid="awsv4-editor">
      <span>The request is signed when it is sent.</span>
      <InfoTip label="About AWS Signature">
        Slinger signs the request with AWS Signature Version 4 right before sending it, after all headers and the body are final, and
        signs it again for each redirect that keeps the authorization (a redirect to another site drops it). It adds
        <code>Authorization</code>, <code>X-Amz-Date</code>, <code>X-Amz-Security-Token</code> (with a session token) and, for S3,
        <code>X-Amz-Content-Sha256</code>. An empty region or service means <code>us-east-1</code> / <code>execute-api</code>, as in Postman.
      </InfoTip>
    </div>
    {@render field('Access key', aws.accessKey, (v) => setAws('accessKey', v), { placeholder: 'AKIA… or {{variable}}' })}
    {@render field('Secret key', aws.secretKey, (v) => setAws('secretKey', v), { secret: true })}
    {@render field('AWS region', aws.region, (v) => setAws('region', v), { placeholder: 'us-east-1' })}
    {@render field('Service name', aws.service, (v) => setAws('service', v), { placeholder: 'execute-api (e.g. s3, sts, es)' })}
    {@render field('Session token', aws.sessionToken, (v) => setAws('sessionToken', v), { secret: true, placeholder: 'Only for temporary credentials' })}
    {#if aws.addAuthDataToQuery}
      <p class="rounded border border-warning bg-warning-soft px-3 py-2 text-sm">
        This auth asks for the signature in the query string (a Postman option). Slinger sends it in the Authorization header instead.
      </p>
    {/if}
  {:else if a.kind === 'oauth2'}
    <OAuth2Panel bind:oauth2={auth.oauth2} {collectionId} />
  {:else if a.kind === 'unsupported'}
    <p class="rounded border border-warning bg-warning-soft px-3 py-2 text-sm">
      {subject} uses <strong>{a.unsupportedType ?? 'custom'}</strong> authorization, which Slinger cannot edit or send. The original settings are kept when you save;
      choose another type above to replace them.
    </p>
  {:else}
    <p class="text-sm text-muted">
      {subject} does not use any authorization{level === 'request' ? '' : level === 'folder' ? ', and neither do the requests in it that inherit' : '; requests that inherit send none'}.
    </p>
  {/if}
  {#if a.kind !== 'none' && a.kind !== 'unsupported' && a.kind !== 'inherit'}
    <p class="text-xs text-faint">
      Values may use <code>{'{{variables}}'}</code>. Credentials are resolved when the request is sent.{level !== 'request' ? ' Requests set to inherit use these settings.' : ''}
    </p>
  {/if}
</div>
