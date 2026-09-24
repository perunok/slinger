export interface ThemeInfo {
  id: string
  label: string
  /** Approximate swatch colours for the picker preview only. */
  swatch: [bg: string, surface: string, accent: string, text: string]
}

export const THEMES: ThemeInfo[] = [
  { id: 'light', label: 'Light', swatch: ['#f4f5f7', '#ffffff', '#2563eb', '#1c2330'] },
  { id: 'dark', label: 'Dark', swatch: ['#16181d', '#1e2127', '#4c8dff', '#e4e7ec'] },
  { id: 'midnight', label: 'Midnight', swatch: ['#070d1f', '#0d1630', '#5b9dff', '#dbe5ff'] },
  { id: 'solarized', label: 'Solarized Dark', swatch: ['#001f27', '#002b36', '#2aa198', '#eee8d5'] },
  { id: 'contrast', label: 'High Contrast', swatch: ['#000000', '#000000', '#ffd400', '#ffffff'] },
]

export type ThemeChoice = 'system' | (typeof THEMES)[number]['id']

export function resolveTheme(choice: string, prefersLight: boolean): string {
  if (choice === 'system') return prefersLight ? 'light' : 'dark'
  return THEMES.some((t) => t.id === choice) ? choice : 'dark'
}
