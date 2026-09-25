/**
 * Browser mock of runScripts. The QuickJS sandbox exists only in the Electron main process, so the mock does
 * not execute anything: it passes the scopes through unchanged and says so once per run in the console, so the
 * send pipeline (and components that show results) still work in `npm run dev` and in renderer tests.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { RunScriptsResult } from '../../../shared/types'

export function createScriptsApi(): Pick<SlingerIpcApi, 'runScripts'> {
  return {
    async runScripts(input): Promise<RunScriptsResult> {
      return {
        event: input.event,
        errors: [],
        request: null,
        variables: input.variables,
        collectionVariables: input.collectionVariables,
        globals: input.globals,
        environmentChanged: false,
        console: [
          {
            level: 'warn',
            message: `Scripts are not run in the browser preview (mock backend): ${input.scripts.length} ${input.event === 'test' ? 'test' : 'pre-request'} script(s) skipped.`,
            timestamp: Date.now(),
            source: 'Slinger',
          },
        ],
        tests: [],
        durationMs: 0,
      }
    },
  }
}
