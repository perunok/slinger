import React from 'react'

export default function Header({ selectedRequest }: { selectedRequest: { name?: string } | null }) {
  return (
    <header className="flex h-7 items-center border-b border-[var(--border)] bg-[var(--toolbar)] px-3 text-[13px]">
      <div className="flex w-1/3 items-center gap-4 font-medium text-[var(--text)]">
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
        <span>Help</span>
      </div>
      <div className="w-1/3 truncate text-center text-[var(--text)]">
        {selectedRequest ? `${selectedRequest.name} - Slinger` : 'Slinger'}
      </div>
      <div className="flex w-1/3 justify-end gap-3 text-[var(--muted)]">
        <span>Invite</span>
        <span>Upgrade</span>
      </div>
    </header>
  )
}
