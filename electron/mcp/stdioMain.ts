// Entry of dist-electron/mcp-stdio.cjs, copied to <userData>/mcp/bridge.cjs (see stdioBridge.ts). It reads endpoint.json
// and launch.json from its own folder.
import { runBridge } from './stdioBridge'

runBridge(__dirname)
