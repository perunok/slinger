<script lang="ts">
  /** Mounted once by App: runs the tool calls main forwards from MCP clients and sends back the results. */
  import { onMount } from 'svelte'
  import { api } from '../../lib/ipc'
  import { mcp } from './mcpStore.svelte'
  import { runTool } from './tools'

  onMount(() => {
    void mcp.load()
    const unsubscribe = api().onMcpCall(async (call) => {
      mcp.begin(call.tool)
      try {
        const result = await runTool(call.tool, call.args)
        await api().mcpRespond(call.id, result)
      } catch {
        // mcpRespond itself failed (result too large...): answer with a short error so the client is not left waiting.
        await api()
          .mcpRespond(call.id, { ok: false, error: 'Slinger could not return the result (too large?).' })
          .catch(() => {})
      } finally {
        mcp.end()
      }
    })
    // Calls that arrived while the window was starting wait for this.
    void api().mcpHostReady()
    return unsubscribe
  })
</script>
