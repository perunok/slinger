import './styles/app.css'
import { mount } from 'svelte'
import App from './app/App.svelte'
import { dismissBootSkeleton, markBoot, markMounted } from './app/bootSkeleton'

markBoot()

async function boot() {
  // Outside Electron (plain browser / `npm run dev`) there is no preload bridge: use the in-memory mock.
  if (typeof window.slinger === 'undefined') {
    const { installMockBackend } = await import('./dev/mockBackend')
    installMockBackend()
  }
  mount(App, { target: document.getElementById('root')! })
  markMounted()
}

// The launch skeleton (index.html) is removed by App.svelte once the first workspace has loaded. If the app cannot
// even mount, drop it here so the error below is not hidden behind it.
boot().catch((err: unknown) => {
  console.error(err)
  dismissBootSkeleton('error')
  const root = document.getElementById('root')
  if (root) {
    root.textContent = `Slinger could not start: ${err instanceof Error ? err.message : String(err)}`
    root.setAttribute('role', 'alert')
  }
})
