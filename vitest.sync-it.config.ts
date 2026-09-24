import { defineConfig } from 'vitest/config'

// Integration + convergence tests of the desktop sync engine against a REAL slinger-admin server and a throwaway
// PostgreSQL (docker). Skipped unless SLINGER_SYNC_IT_SERVER_DIR points at slinger-admin/server:
//   SLINGER_SYNC_IT_SERVER_DIR=../slinger-admin/server npm run test:sync-it
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/__tests__/sync-it/**/*.it.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
