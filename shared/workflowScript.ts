/**
 * How a workflow's JavaScript (Evaluate, If, For each, Set variable) runs in the script sandbox (runScripts): the
 * value that arrived is the iteration data entry INPUT_KEY, and what the code returns comes back as the pm.variables
 * entry OUTPUT_KEY (src/features/workflows/workflowRuns.svelte.ts removes it again).
 *
 * `await __slinger_body()` is a SyntaxError as global code, so the sandbox runs the whole text as the body of an async
 * function (electron/scripts/sandbox.ts): the user's code may `await` (pm.sendRequest), and an error it throws, also
 * asynchronously, is the script's error. The prefix shares the first line with the user's code, so line numbers match.
 */
export const WORKFLOW_INPUT_KEY = '__slinger_input'
export const WORKFLOW_OUTPUT_KEY = '__slinger_output'

export const workflowScript = (code: string): string =>
  `const input = pm.iterationData.get(${JSON.stringify(WORKFLOW_INPUT_KEY)}); const __slinger_body = async () => {${code}\n}; const __slinger_result = await __slinger_body(); pm.variables.set(${JSON.stringify(WORKFLOW_OUTPUT_KEY)}, __slinger_result === undefined ? null : __slinger_result);`
