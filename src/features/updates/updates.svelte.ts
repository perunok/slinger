/**
 * New-release notice. The main process asks GitHub (checkForUpdates); this store decides when (once a day while
 * "Check for new releases automatically" is on, plus Help > Check for Updates… and Settings > Check now) and shows one
 * notification per new version. Its "Update now" opens the Update Slinger dialog: the main process downloads the installer
 * (progress pushed on `update:state`), verifies it, and installs it on "Restart to update" (services/updateInstall.ts).
 * Installations that cannot update themselves (development builds, ...) get "View release" instead.
 */
import type { ReleaseInfo, UpdateCheckResult, UpdateInstallState } from '../../../shared/types'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { isCheckDue, isNewer, loadUpdatePrefs, shouldNotify, UPDATES_STORAGE_KEY, type UpdatePrefs } from '../../lib/updates'

/** First automatic check this long after startup (startup work goes first), then re-checked hourly whether one is due. */
const STARTUP_DELAY_MS = 8000
const POLL_MS = 60 * 60 * 1000

/** `auto`: silent unless a new version; `menu`: always answers with a notification; `settings`: answers inline. */
export type CheckSource = 'auto' | 'menu' | 'settings'

function readPrefs(): UpdatePrefs {
  try {
    return loadUpdatePrefs(localStorage.getItem(UPDATES_STORAGE_KEY))
  } catch {
    return loadUpdatePrefs(null)
  }
}

class UpdatesStore {
  #prefs = readPrefs()
  auto = $state(this.#prefs.auto)
  latest = $state<ReleaseInfo | null>(this.#prefs.latest)
  lastCheckedAt = $state<number | null>(this.#prefs.lastCheckedAt)
  currentVersion = $state<string | null>(null)
  checking = $state(false)
  /** The last check's failure (cleared by the next success). */
  error = $state<string | null>(null)
  /** The in-app updater's state (null until known, or when the backend has none). */
  install = $state<UpdateInstallState | null>(null)

  /** This installation can download and install updates itself. */
  get canInstall(): boolean {
    return !!this.install?.method
  }

  /** The newer release, if the last check found one. */
  get available(): ReleaseInfo | null {
    return isNewer(this.latest, this.currentVersion) ? this.latest : null
  }

  /** Starts the automatic schedule; returns the stop function. */
  start(): () => void {
    let stopped = false
    const tick = () => {
      if (!stopped && isCheckDue(this.#prefs, Date.now())) void this.check('auto')
    }
    const first = setTimeout(tick, STARTUP_DELAY_MS)
    const poll = setInterval(tick, POLL_MS)
    void this.#loadVersion()
    const off = api().onUpdateState?.((s) => (this.install = s)) ?? null
    api()
      .getUpdateInstallState?.()
      .then((s) => (this.install ??= s), () => {})
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(poll)
      off?.()
    }
  }

  async check(source: CheckSource): Promise<UpdateCheckResult | null> {
    if (this.checking) return null
    this.checking = true
    try {
      const result = await api().checkForUpdates()
      this.currentVersion = result.currentVersion
      this.latest = result.latest
      this.lastCheckedAt = result.checkedAt
      this.error = null
      const notify = source === 'menu' ? isNewer(result.latest, result.currentVersion) : shouldNotify(this.#prefs, result.latest, result.currentVersion)
      this.#save({ lastCheckedAt: result.checkedAt, latest: result.latest, notified: isNewer(result.latest, result.currentVersion) ? result.latest!.version : this.#prefs.notified })
      // Settings shows the answer itself; the notification is for the automatic check and the menu.
      if (notify && source !== 'settings') this.#notify(result.latest!, result.currentVersion)
      else if (source === 'menu') toast.success('Slinger is up to date', `${result.currentVersion} is the latest release.`)
      return result
    } catch (e) {
      this.error = errorInfo(e).message
      if (source === 'menu') toast.error('Could not check for updates', this.error)
      return null
    } finally {
      this.checking = false
    }
  }

  setAuto(v: boolean) {
    this.auto = v
    this.#save({ auto: v })
  }

  /** Opens the Update Slinger dialog and starts downloading (unless a download is already going or done). */
  async updateNow(): Promise<void> {
    ui.updateOpen = true
    const phase = this.install?.phase
    if (phase === 'downloading' || phase === 'verifying' || phase === 'ready' || phase === 'installing') return
    try {
      this.install = await api().downloadUpdate()
    } catch (e) {
      if (this.install) this.install = { ...this.install, phase: 'error', error: errorInfo(e).message }
      else toast.error('Could not download the update', errorInfo(e).message)
    }
  }

  async cancelDownload(): Promise<void> {
    try {
      this.install = await api().cancelUpdateDownload()
    } catch (e) {
      toast.error('Could not cancel the download', errorInfo(e).message)
    }
  }

  /** Installs the downloaded update; Slinger quits and starts again. A failure stays in `install.error`. */
  async restartToUpdate(): Promise<void> {
    try {
      this.install = await api().installUpdate()
    } catch (e) {
      if (this.install) this.install = { ...this.install, phase: 'error', error: errorInfo(e).message }
    }
  }

  openRelease(release: ReleaseInfo | null = this.available) {
    if (!release) return
    api()
      .openExternalUrl(release.url)
      .catch((e) => toast.error('Could not open the release page', errorInfo(e).message))
  }

  /** Test hook: forget this session and re-read localStorage. */
  resetForTests() {
    this.#prefs = readPrefs()
    this.auto = this.#prefs.auto
    this.latest = this.#prefs.latest
    this.lastCheckedAt = this.#prefs.lastCheckedAt
    this.currentVersion = null
    this.checking = false
    this.error = null
    this.install = null
  }

  #notify(release: ReleaseInfo, currentVersion: string) {
    // Stays until dismissed: it is shown at most once per version.
    toast.push(
      'info',
      `Slinger ${release.version} is available`,
      `You have ${currentVersion}.`,
      0,
      this.canInstall ? { label: 'Update now', run: () => void this.updateNow() } : { label: 'View release', run: () => this.openRelease(release) },
    )
  }

  async #loadVersion() {
    try {
      this.currentVersion ??= await api().getAppVersion()
    } catch {
      /* the Settings line just shows no version */
    }
  }

  #save(patch: Partial<UpdatePrefs>) {
    this.#prefs = { ...this.#prefs, ...patch }
    try {
      localStorage.setItem(UPDATES_STORAGE_KEY, JSON.stringify(this.#prefs))
    } catch {
      /* storage unavailable: this session only */
    }
  }
}

export const updates = new UpdatesStore()
