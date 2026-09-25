export interface ThemeInfo {
  id: string
  label: string
}

/** Palettes live in src/styles/themes.css (`[data-theme='<id>']`). Add a theme there and here. */
export const THEMES: ThemeInfo[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'solarized', label: 'Solarized Dark' },
  { id: 'contrast', label: 'High Contrast' },
]

export type ThemeChoice = 'system' | (typeof THEMES)[number]['id']

export function resolveTheme(choice: string, prefersLight: boolean): string {
  if (choice === 'system') return prefersLight ? 'light' : 'dark'
  return THEMES.some((t) => t.id === choice) ? choice : 'dark'
}
