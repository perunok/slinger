/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'
import { acknowledgementsVitePlugin } from './scripts/acknowledgements.mjs'

// One config for: `vite dev` in a plain browser (mock backend), the Electron dev loop
// (electron:dev points the window at this server), the production build (relative base so the
// bundle loads from the app:// origin), and the renderer's vitest suite.
export default defineConfig({
  base: './',
  // acknowledgementsVitePlugin: `virtual:acknowledgements` (About dialog) + THIRD_PARTY_LICENSES.txt in dist/.
  plugins: [svelte(), svelteTesting(), acknowledgementsVitePlugin()],
  server: { port: 5173 },
  build: {
    // CodeMirror ships as a few large modules.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts'],
    css: false,
  },
})
