/**
 * URLs typed without a scheme, as Postman takes them: `example.com/x` and `localhost:3000` are http, `//host/x` is a
 * scheme-relative http URL, and an explicit port 443 means https (`api.example.com:443/x`). Used by every place a URL
 * leaves the app (requests, scripts' sendRequest, MCP requests, OAuth 2.0 endpoints, the cloud address, OpenAPI URLs),
 * so none of them asks the user for `http://`. Does not validate; `{{variables}}` are resolved before this.
 */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

export function withDefaultScheme(url: string): string {
  const t = url.trim()
  if (!t || SCHEME.test(t)) return t
  if (t.startsWith('//')) return `http:${t}`
  // host[:port] before the first / ? or #; a 443 port (after optional user:pass@) means TLS.
  const authority = t.split(/[/?#]/, 1)[0]!
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  return /:443$/.test(hostPort) ? `https://${t}` : `http://${t}`
}
