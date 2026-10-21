import { describe, expect, it } from 'vitest'
import type { WorkspaceMember } from '../../../shared/types'
import { formatJoined, isTeamWorkspace, memberName, membersLabel, sortMembers } from './team'

const member = (over: Partial<WorkspaceMember>): WorkspaceMember => ({
  id: over.email ?? 'm', userId: `u-${over.email ?? 'm'}`, email: 'a@example.com', displayName: 'A', role: 'editor', joinedAt: 1_700_000_000, isYou: false, ...over,
})

describe('isTeamWorkspace', () => {
  it('is true for a workspace downloaded from the cloud, whatever the member count', () => {
    expect(isTeamWorkspace({ workspaceType: 'team' }, null)).toBe(true)
    expect(isTeamWorkspace({ workspaceType: 'team' }, { members: 1 })).toBe(true)
    expect(isTeamWorkspace({ workspaceType: 'team' }, { members: null })).toBe(true)
  })
  it('is true for a personal workspace that has been shared (more than one member)', () => {
    expect(isTeamWorkspace({ workspaceType: 'personal' }, { members: 2 })).toBe(true)
    expect(isTeamWorkspace({ workspaceType: 'personal' }, { members: 40 })).toBe(true)
  })
  it('is false for a personal workspace with only you, an unknown count or no status', () => {
    expect(isTeamWorkspace({ workspaceType: 'personal' }, { members: 1 })).toBe(false)
    expect(isTeamWorkspace({ workspaceType: 'personal' }, { members: 0 })).toBe(false)
    expect(isTeamWorkspace({ workspaceType: 'personal' }, { members: null })).toBe(false)
    expect(isTeamWorkspace({ workspaceType: 'personal' }, null)).toBe(false)
    expect(isTeamWorkspace({ workspaceType: 'personal' }, undefined)).toBe(false)
  })
})

describe('membersLabel', () => {
  it('pluralises', () => {
    expect(membersLabel(1)).toBe('1 member')
    expect(membersLabel(0)).toBe('0 members')
    expect(membersLabel(12)).toBe('12 members')
  })
})

describe('sortMembers', () => {
  it('orders owner, admin, editor, viewer, then by name', () => {
    const list = [
      member({ email: 'v@x', displayName: 'Zed', role: 'viewer' }),
      member({ email: 'e2@x', displayName: 'bea', role: 'editor' }),
      member({ email: 'o@x', displayName: 'Owen', role: 'owner' }),
      member({ email: 'e1@x', displayName: 'Abe', role: 'editor' }),
      member({ email: 'a@x', displayName: 'Ada', role: 'admin' }),
    ]
    expect(sortMembers(list).map((m) => m.displayName)).toEqual(['Owen', 'Ada', 'Abe', 'bea', 'Zed'])
  })
  it('falls back to the email as the name and does not change its input', () => {
    const list = [member({ email: 'zoe@x', displayName: '', role: 'editor' }), member({ email: 'amy@x', displayName: ' ', role: 'editor' })]
    expect(sortMembers(list).map((m) => m.email)).toEqual(['amy@x', 'zoe@x'])
    expect(list[0]!.email).toBe('zoe@x')
  })
})

describe('memberName / formatJoined', () => {
  it('shows the display name, else the email', () => {
    expect(memberName({ displayName: 'Ana', email: 'ana@x' })).toBe('Ana')
    expect(memberName({ displayName: '  ', email: 'ana@x' })).toBe('ana@x')
  })
  it('formats the join date and stays empty when unknown', () => {
    expect(formatJoined(1_700_000_000)).toBe(`Joined ${new Date(1_700_000_000_000).toLocaleDateString([], { dateStyle: 'medium' })}`)
    expect(formatJoined(0)).toBe('')
  })
})
