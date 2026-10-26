/**
 * What's new: on the first start of a new version (not a fresh install), open the Release notes dialog with the
 * versions since the last one this installation ran. The decision is pure (lib/releaseNotes.ts); the changelog is
 * loaded only when the version changed.
 */
import { ui } from '../../app/ui.svelte'
import { api } from '../../lib/ipc'
import { decideWhatsNew, entriesSince, EXISTING_INSTALL_KEYS, loadSeenVersion, WHATS_NEW_STORAGE_KEY } from '../../lib/releaseNotes'

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** Runs once at startup. Never throws. */
export async function checkWhatsNew(): Promise<void> {
  try {
    const store = storage()
    if (!store) return
    const current = await api().getAppVersion()
    const seen = loadSeenVersion(store.getItem(WHATS_NEW_STORAGE_KEY))
    const existing = EXISTING_INSTALL_KEYS.some((k) => store.getItem(k) !== null)
    const decision = decideWhatsNew(seen, current, existing)
    if (decision.record) store.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify({ seen: current }))
    if (!decision.show) return
    const { CHANGELOG } = await import('./changelog')
    if (entriesSince(CHANGELOG, decision.after, current).length === 0) return
    // Something else opened it meanwhile (the user was quicker): leave it.
    ui.releaseNotes ??= { mode: 'new', after: decision.after, current }
  } catch {
    /* no version, storage full: no What's new this time */
  }
}
