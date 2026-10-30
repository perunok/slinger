/** What the HTTP executor needs from a cookie jar. Implemented by the cookie service (stream C). */
export interface CookieJarPort {
  /** The `Cookie` header value for a request to `url` (RFC 6265 matching: domain, path, Secure, expiry), or null. */
  cookieHeaderFor(url: URL): Promise<string | null>
  /** Stores the `Set-Cookie` headers of one response (each redirect hop is one call), as received from `url`. */
  storeFromResponse(url: URL, setCookieHeaders: string[]): Promise<void>
}
