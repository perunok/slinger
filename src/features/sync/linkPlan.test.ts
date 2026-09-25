import { describe, expect, it } from 'vitest'
import type { RemoteWorkspacePreview } from '../../../shared/types'
import { linkPlan, remoteContentSummary } from './linkPlan'

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

describe('remoteContentSummary', () => {
  it('summarises the cloud content counts of the preview (lower bounds when truncated)', () => {
    expect(remoteContentSummary(undefined)).toBeNull()
    expect(remoteContentSummary(null)).toBeNull()
    expect(remoteContentSummary({ collections: 1, folders: 4, requests: 3, environments: 0, truncated: false })).toBe('1 collection, 3 requests, 0 environments')
    expect(remoteContentSummary({ collections: 2, folders: 0, requests: 1, environments: 1, truncated: true })).toBe('at least 2 collections, at least 1 request, at least 1 environment')
  })
})
