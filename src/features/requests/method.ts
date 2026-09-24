const COLORS: Record<string, string> = {
  GET: 'var(--m-get)',
  POST: 'var(--m-post)',
  PUT: 'var(--m-put)',
  PATCH: 'var(--m-patch)',
  DELETE: 'var(--m-delete)',
}
export function methodColor(method: string): string {
  return COLORS[method.toUpperCase()] ?? 'var(--m-other)'
}
