// esbuild plugin for `import text from './file.js?raw'` (the same syntax Vite/Vitest understand natively).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const rawPlugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }))
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
  },
}
