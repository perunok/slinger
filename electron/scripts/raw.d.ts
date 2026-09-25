/** Text imports (`import text from './file.js?raw'`): Vite/Vitest natively, esbuild via scripts/esbuild-raw.mjs. */
declare module '*?raw' {
  const content: string
  export default content
}

/**
 * The script sandbox's built-in libraries (scripts/sandbox-libs.mjs): require() name -> bundled source text,
 * a `(function (module, exports) { ... })` expression evaluated only inside QuickJS.
 */
declare module 'virtual:sandbox-libs' {
  const libraries: Record<string, string>
  export default libraries
}
