/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'

export default defineConfig({
  // Relative asset paths so the production build also loads from file:// in Electron.
  base: './',
  plugins: [svelte(), svelteTesting()],
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts'],
    css: false,
  },
})
