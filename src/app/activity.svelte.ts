/**
 * Background activity the status bar reports that is not already app or tab state: today the collection runner's
 * progress (the runner session publishes it while a run is going). Request sends are read from the tabs directly.
 */
export interface RunnerActivity {
  /** Collection or folder name. */
  label: string
  done: number
  total: number
}

class ActivityState {
  runner = $state<RunnerActivity | null>(null)
}

export const activity = new ActivityState()
