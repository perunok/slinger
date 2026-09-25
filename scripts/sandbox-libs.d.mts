// Types for scripts/sandbox-libs.mjs (imported by vitest.config.ts).
import type { Plugin as EsbuildPlugin } from 'esbuild'
import type { Plugin as VitePlugin } from 'vite'

export declare const SANDBOX_LIBRARIES: Record<string, { entry: string; buffer?: boolean }>
export declare function buildSandboxLibraries(): Promise<Record<string, string>>
export declare const sandboxLibsEsbuildPlugin: EsbuildPlugin
export declare function sandboxLibsVitePlugin(): VitePlugin
