// Bundles the Electron main process and preload script (TypeScript -> CommonJS).
// Native addons stay external; everything else (zod, uuid, shared/*) is inlined so
// the sandboxed preload only ever requires 'electron'.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20', // Electron 33 embeds Node 20
  sourcemap: true,
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: { main: 'electron/main.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'better-sqlite3', '@napi-rs/*'],
})
await build({
  ...common,
  entryPoints: { preload: 'electron/preload.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
})
