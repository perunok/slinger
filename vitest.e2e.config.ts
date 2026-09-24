import { defineConfig } from 'vitest/config'

// End-to-end suite: drives the real, built Electron app (see e2e/README in docs or package.json).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
