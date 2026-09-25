/**
 * Worker-thread entry (bundled to dist-electron/script-worker.cjs). Runs script chains off the main thread so a
 * busy script never blocks IPC (cancelHttpRequest keeps working) and a runaway one can be terminated.
 *
 * Per job the main thread sends: the job, a SharedArrayBuffer with two Int32 slots ([0] cancel flag set by
 * main, [1] secret-reply flag) and a MessagePort for secret reads. A secret read is synchronous for the
 * script: post {id} on the port, block in Atomics.wait until main stored the reply, then take the reply with
 * receiveMessageOnPort. Secrets therefore stay in the main process until a script asks for one by name.
 */
import { parentPort, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'
import type { ScriptJob } from './job'
import { runScriptChain } from './sandbox'

export interface WorkerJobMessage {
  type: 'run'
  jobId: number
  job: ScriptJob
  control: SharedArrayBuffer
  port: MessagePort
}

export type WorkerReply =
  | { type: 'result'; jobId: number; result: Awaited<ReturnType<typeof runScriptChain>> }
  | { type: 'failed'; jobId: number; message: string }
  | { type: 'ready' }

/** Longest a script waits for one secret from the keychain before treating it as missing. */
const SECRET_WAIT_MS = 15_000

function secretReader(control: Int32Array, port: MessagePort) {
  return (variableId: string): string | null => {
    Atomics.store(control, 1, 0)
    port.postMessage({ type: 'secret', id: variableId })
    const status = Atomics.wait(control, 1, 0, SECRET_WAIT_MS)
    if (status === 'timed-out') return null
    // The reply is enqueued before the flag is set, so it is available now.
    const reply = receiveMessageOnPort(port)?.message as { value?: unknown } | undefined
    return typeof reply?.value === 'string' ? reply.value : null
  }
}

if (parentPort) {
  const parent = parentPort
  parent.on('message', (msg: WorkerJobMessage) => {
    if (msg?.type !== 'run') return
    const control = new Int32Array(msg.control)
    void runScriptChain(msg.job, {
      readSecret: secretReader(control, msg.port),
      isCancelled: () => Atomics.load(control, 0) === 1,
    }).then(
      (result) => {
        msg.port.close()
        parent.postMessage({ type: 'result', jobId: msg.jobId, result } satisfies WorkerReply)
      },
      (err: unknown) => {
        msg.port.close()
        parent.postMessage({ type: 'failed', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) } satisfies WorkerReply)
      },
    )
  })
  parent.postMessage({ type: 'ready' } satisfies WorkerReply)
}
