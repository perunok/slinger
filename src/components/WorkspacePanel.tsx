import type { Workspace } from '../tauri'

interface WorkspacePanelProps {
  workspaces: Workspace[]
}

export default function WorkspacePanel({ workspaces }: WorkspacePanelProps) {
  return (
    <div className="mt-4 space-y-3">
      {workspaces.map((workspace) => (
        <div key={workspace.id} className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3">
          <p className="text-sm font-medium text-slate-100">{workspace.name}</p>
          <p className="text-xs text-slate-500">Workspace ID: {workspace.id}</p>
        </div>
      ))}
    </div>
  )
}
