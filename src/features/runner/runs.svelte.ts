/**
 * Collection runs, independent of the runner dialog. A run keeps going when its dialog is closed (it runs "in the
 * background"): the status bar shows its progress and reopens it, and a toast says when it finished. One session per
 * target (a collection or one folder of it) in the open workspace.
 *
 * A run keeps the environment it started with (switching environments meanwhile changes nothing for it). It needs the
 * workspace it started in (collection and folder scripts, collection variables, globals), so switching workspaces stops
 * the runs of the workspace being left.
 */
import { settings } from '../../app/settings.svelte'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import type { DataFile } from '../../lib/dataFile'
import { pickLoader, prefersReducedMotion, type LoaderKind } from '../../lib/loader'
import { parseDocument } from '../../lib/request'
import { uuid } from '../../lib/template'
import { cancelRun, executeDraft, newScriptRun } from '../requests/execute'
import { CollectionRun, summarize, type RunItem, type RunOptions, type RunState } from './runner'

export interface RunTarget {
  collectionId: string
  folderId: string | null
}

export const sameTarget = (a: RunTarget | null | undefined, b: RunTarget | null | undefined): boolean =>
  !!a && !!b && a.collectionId === b.collectionId && (a.folderId ?? null) === (b.folderId ?? null)

export interface RunLoader {
  kind: LoaderKind
  startedAt: number
}

export class RunSession {
  readonly id = uuid()
  state = $state.raw<RunState>(null as unknown as RunState)
  /** Finished while its dialog was closed: the status bar keeps pointing to the results until they are opened. */
  unseen = $state(false)

  constructor(
    readonly workspaceId: string,
    readonly target: RunTarget,
    /** Collection or folder name. */
    readonly label: string,
    /** The environment the run uses throughout (null: none), whatever is active meanwhile. */
    readonly environment: { id: string; name: string } | null,
    /** The small loading character over the progress bar (none for the classic spinner or reduced motion). */
    readonly loader: RunLoader | null,
    /** What was run, and how: a reopened dialog's "Configure" / "Run again" start from these. */
    readonly itemIds: string[] = [],
    readonly options: RunOptions = { delayMs: 0, stopOnFailure: false },
    /** The data file of a data-driven run (its rows are `options.data`). */
    readonly dataFile: DataFile | null = null,
  ) {}

  run!: CollectionRun
  /** Resolves when the run has ended (finished, stopped or failed). */
  finished: Promise<void> = Promise.resolve()

  get running(): boolean {
    return this.state.phase === 'running'
  }
}

/** "8 passed, 2 failed · tests 10/12" */
export function runSummaryText(state: RunState): string {
  const s = summarize(state)
  const parts = [`${s.passed} passed`, `${s.failed} failed`]
  if (s.skipped) parts.push(`${s.skipped} skipped`)
  let text = parts.join(', ')
  if (s.iterations > 1) text += ` in ${s.iterations} iterations`
  if (s.tests.total > 0) text += ` · tests ${s.tests.passed}/${s.tests.total}`
  return text
}

class RunsStore {
  sessions = $state.raw<RunSession[]>([])
  /** What the status bar shows: runs going on, and finished ones whose results were not looked at yet. */
  attention = $derived(this.sessions.filter((s) => s.running || s.unseen))

  forTarget(target: RunTarget): RunSession | undefined {
    return this.sessions.find((s) => s.workspaceId === app.workspaceId && sameTarget(s.target, target))
  }

  /** Starts a run of `items` for `target` (a running one for the same target is returned as is). */
  /** `environment`: run with this one instead of the active environment (null: none). */
  start(input: {
    workspaceId: string
    target: RunTarget
    label: string
    items: RunItem[]
    options: RunOptions
    dataFile?: DataFile | null
    environment?: { id: string; name: string } | null
    /** 'mcp': started by an AI assistant (its sends are flagged in History). */
    source?: 'mcp'
  }): RunSession {
    const existing = this.forTarget(input.target)
    if (existing?.running) return existing
    const { workspaceId } = input
    const active = app.activeEnvironment
    const environment =
      input.environment !== undefined ? input.environment : active && active.workspaceId === workspaceId ? { id: active.id, name: active.name } : null
    const kind = pickLoader(settings.loader)
    const loader = kind === 'classic' || prefersReducedMotion() ? null : { kind, startedAt: Date.now() }
    const dataFile = input.dataFile ?? null
    const options: RunOptions = { ...input.options, data: dataFile?.rows ?? null }
    const session = new RunSession(workspaceId, { ...input.target }, input.label, environment, loader, input.items.map((i) => i.id), options, dataFile)
    // One script context for the whole run: pm.variables set by one request reach the next ones (across iterations,
    // as in Postman); the iteration fields follow the request being run.
    const scriptRun = newScriptRun()
    scriptRun.iterationCount = Math.max(1, options.iterations ?? 1)
    session.run = new CollectionRun(input.items, options, {
      execute: (item, hooks) => {
        scriptRun.iteration = hooks.iteration
        scriptRun.iterationData = hooks.data
        return executeDraft(parseDocument(item.request), {
          workspaceId,
          requestId: item.request.id,
          collectionId: item.request.collectionId,
          folderId: item.request.folderId,
          run: scriptRun,
          environment,
          onRunId: hooks.onRunId,
          wasCancelled: hooks.wasCancelled,
          ...(input.source ? { source: input.source } : {}),
        })
      },
      cancel: cancelRun,
      onUpdate: (s) => (session.state = s),
      onItemFinished: () => app.historyTick++,
    })
    session.state = session.run.state
    this.sessions = [...this.sessions.filter((s) => s !== existing), session]
    session.finished = session.run.start().then(() => this.#finished(session))
    return session
  }

  #finished(session: RunSession) {
    // Dismissed meanwhile (workspace switch), or its dialog is open: nothing to announce.
    if (!this.sessions.includes(session) || sameTarget(ui.runner, session.target)) return
    session.unseen = true
    const s = summarize(session.state)
    toast.push(
      s.failed > 0 ? 'error' : 'success',
      `Run finished: ${session.label}${session.state.stopped ? ' (stopped)' : ''}`,
      runSummaryText(session.state),
      20000,
      { label: 'View results', run: () => this.open(session) },
    )
  }

  /** Shows the run in the runner dialog. */
  open(session: RunSession) {
    if (!this.sessions.includes(session)) return
    session.unseen = false
    ui.runner = { ...session.target }
  }

  /** The dialog showing `session` closed: a running run continues in the background, finished results are dropped. */
  closed(session: RunSession) {
    if (!session.running) this.dismiss(session)
  }

  /** Stops (if needed) and forgets a run. */
  dismiss(session: RunSession) {
    if (session.running) session.run.stop()
    this.sessions = this.sessions.filter((s) => s !== session)
  }

  runningIn(workspaceId: string | null): RunSession[] {
    return this.sessions.filter((s) => s.running && s.workspaceId === workspaceId)
  }

  /** Why switching away from the open workspace needs a confirmation (runs of it going on), or null. */
  switchWarning(): string | null {
    const running = this.runningIn(app.workspaceId)
    if (running.length === 0) return null
    return running.length === 1
      ? `The run of "${running[0]!.label}" is still going. It needs this workspace, so switching stops it.`
      : `${running.length} collection runs are still going. They need this workspace, so switching stops them.`
  }

  workspaceWillChange(next: string) {
    const leaving = this.sessions.filter((s) => s.workspaceId !== next)
    if (leaving.length === 0) return
    const stopped = leaving.filter((s) => s.running)
    for (const s of stopped) s.run.stop()
    this.sessions = this.sessions.filter((s) => s.workspaceId === next)
    if (stopped.length > 0) {
      toast.info(
        stopped.length === 1 ? `Stopped the run of "${stopped[0]!.label}"` : `Stopped ${stopped.length} collection runs`,
        'A run needs the workspace it started in, so switching workspaces stops it.',
      )
    }
  }
}

export const runsStore = new RunsStore()
app.workspaceWillChange.push((id) => runsStore.workspaceWillChange(id))
