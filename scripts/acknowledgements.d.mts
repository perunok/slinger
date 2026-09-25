// Types for scripts/acknowledgements.mjs (imported by vite.config.ts).
import type { Plugin as VitePlugin } from 'vite'

export interface Acknowledgement {
  name: string
  version: string
  license: string
  homepage: string
  description: string
  group: 'app' | 'sandbox'
  licenseText?: string | null
}
export declare const SANDBOX_PACKAGES: string[]
export declare function homepageOf(pkg: { name: string; homepage?: unknown; repository?: unknown }): string
export declare function collectAcknowledgements(options?: { withText?: boolean; cwd?: string }): Acknowledgement[]
export declare function thirdPartyLicensesText(cwd?: string): string
export declare function acknowledgementsVitePlugin(): VitePlugin
