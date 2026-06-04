import { defineConfig } from 'vite'
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  build: {
    // The JSON editor is now lazy-loaded, but the library itself ships as a large single module.
    chunkSizeWarningLimit: 1200,
  },
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
    }),
  ],
  server: {
    port: 5173,
  },
})
