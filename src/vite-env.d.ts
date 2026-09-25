/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { MockControls } from './dev/mockBackend'

declare global {
  interface Window {
    /** Present only when the in-memory mock backend is installed (browser dev mode). */
    __slingerMock?: MockControls
  }
}
export {}
