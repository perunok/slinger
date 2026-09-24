import { describe, expect, it } from 'vitest'
import type { RemoteWorkspacePreview } from '../../../shared/types'
import { linkPlan } from './linkPlan'

const preview = (over: Partial<RemoteWorkspacePreview> = {}): RemoteWorkspacePreview => ({ id: 'r', name: 'Team', role: 'editor', remoteEmpty: false, linkedLocalWorkspaceId: null, ...over })
const plan = (over: Partial<Parameters<typeof linkPlan>[0]> = {}) => linkPlan({ preview: preview(), localHasContent: true, localLinked: false, hasLocalWorkspace: true, ...over })

describe('linkPlan', () => {
  it('recommends a new workspace when both sides have content', () => {
    expect(plan()).toMatchObject({ canMerge: true, mode: 'new' })
  })
  it('recommends merging into an empty local workspace or when the remote is empty', () => {
    expect(plan({ localHasContent: false }).mode).toBe('merge')
    expect(plan({ preview: preview({ remoteEmpty: true }) }).mode).toBe('merge')
    expect(plan({ preview: preview({ remoteEmpty: null }) }).mode).toBe('new')
  })
  it('forces a download for viewers with local content, and when the local workspace is already linked', () => {
    const v = plan({ preview: preview({ role: 'viewer' }) })
    expect(v).toMatchObject({ canMerge: false, mode: 'new' })
    expect(v.reason).toContain('read-only')
    expect(plan({ localLinked: true })).toMatchObject({ canMerge: false, mode: 'new' })
    expect(plan({ hasLocalWorkspace: false }).canMerge).toBe(false)
  })
  it('a viewer may merge into an EMPTY local workspace (nothing to upload)', () => {
    expect(plan({ preview: preview({ role: 'viewer' }), localHasContent: false })).toMatchObject({ canMerge: true, mode: 'merge' })
  })
})
