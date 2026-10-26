<script lang="ts">
  /** A request's Authorization tab: its own auth, or what it inherits from its folders / collection. */
  import { resolveEffectiveAuth, type AuthSource } from '../../lib/authInheritance'
  import AuthEditor from './AuthEditor.svelte'
  import { authChainFor } from './execute'
  import { tabsStore, type RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const inherited = $derived(tab.draft.auth.kind === 'inherit' ? resolveEffectiveAuth(tab.draft.auth, authChainFor(tab.collectionId, tab.folderId)) : null)

  function openSource(source: AuthSource) {
    const t = tabsStore.openOverview({ kind: source.kind, id: source.id })
    t.overviewSection = 'auth'
  }
</script>

<AuthEditor bind:auth={tab.draft.auth} level="request" collectionId={tab.collectionId} {inherited} onopensource={openSource} />
