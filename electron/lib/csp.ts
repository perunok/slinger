/**
 * Content-Security-Policy for the renderer. The renderer never talks to the network itself
 * (all HTTP goes through the main process), so connect-src is limited to the app origin.
 */
export function contentSecurityPolicy(options: { dev: boolean; devOrigin?: string }): string {
  const self = options.dev && options.devOrigin ? `'self' ${options.devOrigin}` : "'self'"
  const directives: Record<string, string> = {
    'default-src': "'none'",
    'script-src': self,
    // Svelte/JSON editor set inline style attributes; scripts stay strictly external.
    'style-src': `${self} 'unsafe-inline' https://fonts.googleapis.com`,
    'font-src': `${self} data: https://fonts.gstatic.com`,
    'img-src': `${self} data: blob:`,
    'worker-src': `${self} blob:`,
    'connect-src': options.dev && options.devOrigin ? `${self} ${options.devOrigin.replace(/^http/, 'ws')}` : "'self'",
    // The PDF preview is an <iframe src="blob:...">. HTML previews use srcdoc (about:srcdoc is
    // not governed by frame-src) and inherit this policy, so previewed pages cannot run script
    // (script-src 'self' plus a fully sandboxed iframe) or load remote resources.
    'frame-src': 'blob:',
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
    'frame-ancestors': "'none'",
  }
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ')
}
