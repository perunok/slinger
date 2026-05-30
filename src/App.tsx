import { useEffect, useState } from 'react'
import { createWorkspace, getWorkspaces, Workspace } from './tauri'
import WorkspacePanel from './components/WorkspacePanel'

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [name, setName] = useState('Personal')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        const items = await getWorkspaces()
        setWorkspaces(items)
      } catch (err) {
        console.error(err)
        setError('Unable to load workspaces from local storage.')
      } finally {
        setLoading(false)
      }
    }

    loadWorkspaces()
  }, [])

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) return

    try {
      const ws = await createWorkspace(trimmed)
      setWorkspaces((current) => [...current, ws])
      setName('')
      setError(null)
    } catch (err) {
      console.error(err)
      setError('Unable to create workspace.')
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-3">
          <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Slinger</p>
          <h1 className="text-4xl font-semibold">Local-first API development for teams</h1>
          <p className="max-w-2xl text-slate-400">
            Workspaces, collections, environments, and Postman-compatible import support.
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-xl font-semibold">Workspaces</h2>
              <span className="text-sm text-slate-500">{loading ? 'Loading…' : `${workspaces.length} saved`}</span>
            </div>

            {error ? <p className="mt-3 rounded-2xl bg-rose-950/80 p-3 text-sm text-rose-300">{error}</p> : null}

            <WorkspacePanel workspaces={workspaces} />
            <div className="mt-4 flex gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New workspace name"
                className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-500"
              />
              <button
                onClick={handleCreate}
                disabled={!name.trim()}
                className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Collections</h2>
            <p className="text-slate-400">
              This UI is a scaffolding placeholder for future collection, request, and environment tooling.
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
