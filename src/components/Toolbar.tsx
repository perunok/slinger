import React from 'react'

type Props = {
  workspaces: any[]
  selectedWorkspaceId: string | null
  setSelectedWorkspaceId: (id: string | null) => void
  loadingWorkspaces: boolean
  workspaceName: string
  setWorkspaceName: (v: string) => void
  handleCreateWorkspace: (e: any) => void
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
  orientation: 'vertical' | 'horizontal'
  setOrientation: (o: 'vertical' | 'horizontal') => void
}

export default function Toolbar({
  workspaces,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  loadingWorkspaces,
  workspaceName,
  setWorkspaceName,
  handleCreateWorkspace,
  theme,
  setTheme,
  orientation,
  setOrientation,
}: Props) {
  return (
    <div className="flex h-16 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-alt)] px-3">
      <div className="flex items-center gap-2 text-[#a8a8a8]">
        <button className="toolbar-button" aria-label="Back">
          &lt;
        </button>
        <button className="toolbar-button" aria-label="Forward">
          &gt;
        </button>
      </div>

      <select
        value={selectedWorkspaceId ?? ''}
        onChange={(event) => setSelectedWorkspaceId(event.target.value || null)}
        className="select-field h-8 w-52 rounded px-2 text-sm outline-none"
        disabled={loadingWorkspaces}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>

      <form className="flex items-center gap-2" onSubmit={handleCreateWorkspace}>
        <input
          value={workspaceName}
          onChange={(event) => setWorkspaceName(event.target.value)}
          placeholder="New workspace"
          className="h-8 w-40 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
        />
        <button className="secondary-button" disabled={!workspaceName.trim()}>
          Add
        </button>
      </form>

      <div className="mx-auto flex h-8 w-[320px] items-center rounded border border-[var(--border)] bg-[var(--panel)] px-3 text-sm text-[var(--muted)]">
        Search
      </div>

      <button
        className="secondary-button"
        type="button"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5"></circle>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        )}
      </button>
      <button
        className="secondary-button"
        type="button"
        aria-label={orientation === 'vertical' ? 'Switch to side-by-side' : 'Switch to stacked'}
        onClick={() => setOrientation(orientation === 'vertical' ? 'horizontal' : 'vertical')}
        title={orientation === 'vertical' ? 'Side-by-side' : 'Stacked'}
      >
        <span className="text-[var(--muted)]">{orientation === 'vertical' ? '⇆' : '⇕'}</span>
      </button>
      <button className="secondary-button">Save</button>
      <button className="secondary-button">Share</button>
    </div>
  )
}
