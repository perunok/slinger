import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// The preload runs before the renderer can load, in every window: keep it small. It once grew to 744 KB because
// shared/menu.ts used zod for a 12-name check.
describe('preload bundle', () => {
  it('stays small and pulls in no libraries', async () => {
    const out = await build({
      entryPoints: ['electron/preload.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(out.metafile.inputs)
    expect(inputs.filter((p) => p.includes('node_modules'))).toEqual([])
    expect(out.outputFiles[0]!.contents.byteLength).toBeLessThan(50 * 1024)
  })
})
