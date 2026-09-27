import type { VarBackend } from './varBackends'

/** Column template of a variable table row (literal class names, so Tailwind keeps them). */
export function gridClass(backend: Pick<VarBackend, 'secrets' | 'enabledColumn'>): string {
  if (backend.enabledColumn && backend.secrets) return 'grid-cols-[2rem_minmax(7rem,1fr)_minmax(9rem,2fr)_4rem_5.5rem]'
  if (backend.enabledColumn) return 'grid-cols-[2rem_minmax(7rem,1fr)_minmax(9rem,2fr)_5.5rem]'
  return 'grid-cols-[minmax(7rem,1fr)_minmax(9rem,2fr)_4rem_5.5rem]'
}
