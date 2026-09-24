/**
 * Which browser permissions the renderer may use. Everything is denied except writing plain text
 * to the clipboard ("Copy" buttons, code snippets), and only for the app's own origin.
 * (Reading the clipboard, notifications, media, geolocation etc. stay denied.)
 */
const ALLOWED = new Set(['clipboard-sanitized-write'])

export function isPermissionAllowed(permission: string, requestingUrl: string, isTrustedUrl: (url: string) => boolean): boolean {
  return ALLOWED.has(permission) && isTrustedUrl(requestingUrl)
}
