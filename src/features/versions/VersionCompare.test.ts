import { render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CollectionSnapshot } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { diffSnapshots } from '../../lib/versionDiff'
import DiffView from './DiffView.svelte'
import VersionCompare from './VersionCompare.svelte'

const doc = (o: object) => JSON.stringify(o)
const snap = (url: string, extra = false): CollectionSnapshot => ({
  collectionName: 'C',
  folders: [{ id: 'f1', parentFolderId: null, name: 'Users', sortOrder: 0 }],
  requests: [
    { id: 'r1', folderId: 'f1', name: 'List', method: 'GET', url, documentJson: doc({}), sortOrder: 0 },
    ...(extra ? [{ id: 'r2', folderId: null, name: 'Health', method: 'POST', url: '/h', documentJson: doc({}), sortOrder: 1 }] : []),
  ],
})

describe('DiffView', () => {
  it('renders summary, groups and before/after', () => {
    const diff = diffSnapshots(snap('/a'), snap('/b', true))
    render(DiffView, { diff, fromLabel: 'v1.0.0', toLabel: 'current collection' })
    expect(screen.getByText(/Changes from/)).toHaveTextContent('v1.0.0 → current collection')
    expect(screen.getByText('1 added')).toBeInTheDocument()
    expect(screen.getByText('1 changed')).toBeInTheDocument()
    expect(screen.getByText('Users/List')).toBeInTheDocument()
    expect(screen.getByLabelText('Before')).toHaveTextContent('/a')
    expect(screen.getByLabelText('After')).toHaveTextContent('/b')
  })

  it('shows the identical state', () => {
    render(DiffView, { diff: diffSnapshots(snap('/a'), snap('/a')), fromLabel: 'a', toLabel: 'b' })
    expect(screen.getByText(/identical/)).toBeInTheDocument()
  })
})

describe('VersionCompare', () => {
  beforeEach(async () => {
    window.slinger = createMockBackend({ latencyMs: 0 })
    await app.init()
  })

  it('compares a version with the current collection', async () => {
    const col = app.collections.find((c) => c.name === 'Demo API')!
    const list = await window.slinger.listCollectionVersions(col.id)
    const detail = await window.slinger.getCollectionVersion(list[0].id)
    render(VersionCompare, { detail, versions: list })
    await waitFor(() => expect(screen.getByText(/Changes from/)).toHaveTextContent('v1.0.0'))
    expect(screen.getByText(/identical/)).toBeInTheDocument()
    expect(screen.getByText(/Unsaved changes in open editor tabs/)).toBeInTheDocument()
  })
})
