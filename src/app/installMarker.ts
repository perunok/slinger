/**
 * Whether this profile existed before this start. Read by the very first import of the entry module (src/main.ts),
 * before any other module runs: several stores write their localStorage keys while loading, which would otherwise
 * make a fresh install look like an update (and open What's new on it).
 */
import { EXISTING_INSTALL_KEYS } from '../lib/releaseNotes'

function read(): boolean {
  try {
    return EXISTING_INSTALL_KEYS.some((k) => localStorage.getItem(k) !== null)
  } catch {
    return false
  }
}

export const existedBeforeStart = read()
