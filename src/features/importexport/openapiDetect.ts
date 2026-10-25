/**
 * Recognising OpenAPI/Swagger documents and links to them in the Import dialog, before asking main to read them. Cheap
 * text checks only: main does the real parsing (and says why something is not a valid document).
 */

/** Text whose start declares `openapi:`/`swagger:` (YAML) or `"openapi"`/`"swagger"` (JSON) at the top level. */
export function looksLikeOpenApi(text: string): boolean {
  const head = text.slice(0, 8192)
  const t = head.trimStart()
  // JSON: the key with a 2.x/3.x version string (an escaped \"openapi\" inside a string value does not match).
  if (t.startsWith('{')) return /"(?:openapi|swagger)"\s*:\s*"[23]\./.test(head)
  // YAML: a top-level key (no indentation) somewhere near the start.
  return /^(?:openapi|swagger)\s*:\s*['"]?[23]\./m.test(head)
}

/**
 * A pasted single http(s) URL that points to an API description (ends in .json/.yaml/.yml or mentions openapi, swagger
 * or api-docs). Anything else pasted is treated as content.
 */
export function specUrlOf(text: string): string | null {
  const t = text.trim()
  if (!/^https?:\/\/\S+$/i.test(t)) return null
  return /\.(?:json|ya?ml)(?:[?#].*)?$/i.test(t) || /openapi|swagger|api-docs/i.test(t) ? t : null
}
