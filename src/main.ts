import './styles/app.css'
import { mount } from 'svelte'
import App from './app/App.svelte'

async function boot() {
  // Outside Electron (plain browser / `npm run dev`) there is no preload bridge: use the in-memory mock.
  if (typeof window.slinger === 'undefined') {
    const { installMockBackend } = await import('./dev/mockBackend')
    installMockBackend()
  }
  mount(App, { target: document.getElementById('root')! })
}

void boot()
