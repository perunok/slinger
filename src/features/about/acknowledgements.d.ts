// `virtual:acknowledgements` is generated at build time by scripts/acknowledgements.mjs (Vite plugin).
declare module 'virtual:acknowledgements' {
  const list: ReadonlyArray<{
    name: string
    version: string
    license: string
    homepage: string
    description: string
    /** 'sandbox': bundled only into the script sandbox (pm.require). */
    group: 'app' | 'sandbox'
  }>
  export default list
}
