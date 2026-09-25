/** Text imports (`import text from './file.js?raw'`): Vite/Vitest natively, esbuild via scripts/esbuild-raw.mjs. */
declare module '*?raw' {
  const content: string
  export default content
}
