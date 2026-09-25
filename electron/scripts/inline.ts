/** Runs script chains on the calling thread (tests). The app uses WorkerExecutor. */
import type { ExecutorIo, ScriptExecutor } from './executor'
import type { ScriptJob, ScriptJobResult } from './job'
import { runScriptChain } from './sandbox'

export class InlineExecutor implements ScriptExecutor {
  run(job: ScriptJob, io: ExecutorIo): Promise<ScriptJobResult> {
    return runScriptChain(job, {
      readSecret: io.readSecret,
      isCancelled: () => io.signal.aborted,
      sendHttp: io.sendHttp ? (call, signal) => io.sendHttp!(call, AbortSignal.any([signal, io.signal])) : undefined,
    })
  }
  async dispose(): Promise<void> {}
}
