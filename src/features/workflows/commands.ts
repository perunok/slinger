/** Hooks the open workflow editor registers, so app-wide shortcuts can reach it (Ctrl+Enter runs, Ctrl+S saves now). */
export const workflowCommands: {
  run: ((workflowId: string) => void) | null
  saveNow: ((workflowId: string) => void) | null
} = { run: null, saveNow: null }
