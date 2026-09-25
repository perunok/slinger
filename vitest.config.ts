import { defineConfig } from 'vitest/config'
import { sandboxLibsVitePlugin } from './scripts/sandbox-libs.mjs'

export default defineConfig({
  // `virtual:sandbox-libs` (the script sandbox's built-in libraries), as the worker bundle gets it from esbuild.
  plugins: [sandboxLibsVitePlugin()],
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
