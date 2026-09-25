<script lang="ts">
  /**
   * The two script editors (Pre-request / Tests) used by the request editor and by the collection/folder
   * Scripts dialog. JavaScript with `pm` autocompletion and snippets; the code runs in the main-process sandbox.
   */
  import { settings } from '../../app/settings.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import { pmCompletion } from '../../components/editor/cm/pmCompletion'
  import Tabs from '../../components/ui/Tabs.svelte'
  import type { ScriptListen } from '../../lib/scripts'

  interface Props {
    prerequest: string
    test: string
    onchange: (listen: ScriptListen, code: string) => void
    active: ScriptListen
    onactivechange: (listen: ScriptListen) => void
    readOnly?: boolean
    /** Unique per instance: tab ids and labels. */
    idPrefix: string
    /** Where these scripts sit in the chain, shown under the tabs. */
    scopeHint?: string
    class?: string
  }
  let { prerequest, test, onchange, active, onactivechange, readOnly = false, idPrefix, scopeHint = '', class: cls = '' }: Props = $props()

  const completion = [pmCompletion()]
  const tabs = $derived([
    { id: 'prerequest', label: 'Pre-request', badge: prerequest.trim() ? '•' : undefined },
    { id: 'test', label: 'Tests', badge: test.trim() ? '•' : undefined },
  ])
  const HINT = {
    prerequest: 'Runs before the request is sent. Variables it sets are used in {{templates}}; request changes apply to this send only.',
    test: 'Runs after the response arrives. Use pm.test() and pm.expect(); results appear in the response Tests tab.',
  } as const
  const PLACEHOLDER = {
    prerequest: "// e.g.\npm.request.headers.upsert({ key: 'X-Request-Id', value: pm.variables.replaceIn('{{$guid}}') })",
    test: "// e.g.\npm.test('Status code is 200', () => {\n  pm.response.to.have.status(200)\n})",
  } as const
</script>

<div class="flex h-full min-h-0 flex-col {cls}" data-testid="{idPrefix}-scripts">
  <Tabs {tabs} value={active} onchange={(v) => onactivechange(v as ScriptListen)} label="Script type" idPrefix="{idPrefix}-script" class="px-2" />
  <p class="px-3 pt-1.5 text-xs text-muted">{HINT[active]}{scopeHint ? ` ${scopeHint}` : ''}</p>
  <div class="min-h-0 flex-1 p-2" role="tabpanel" id="{idPrefix}-script-panel-{active}" aria-labelledby="{idPrefix}-script-{active}">
    {#key active}
      <CodeEditor
        value={active === 'prerequest' ? prerequest : test}
        onchange={(code) => onchange(active, code)}
        language="javascript"
        label={active === 'prerequest' ? 'Pre-request script' : 'Test script'}
        placeholder={PLACEHOLDER[active]}
        wrap={settings.editorWrap}
        {readOnly}
        extensions={completion}
        class="rounded border border-border"
      />
    {/key}
  </div>
</div>
