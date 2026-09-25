import { describe, expect, it } from 'vitest'
import type { CollectionSnapshot } from '../../shared/types'
import { buildPostmanCollection, buildPostmanEnvironment } from './postman'
import { buildSlingerBlock, isoFromSeconds, latestVersion, type VersionForExport } from './slingerExport'

const snap = (name: string): CollectionSnapshot => ({
  collectionName: name,
  folders: [],
  requests: [{ id: 'r1', folderId: null, name: 'Get', method: 'GET', url: 'https://x.test', documentJson: '{}', sortOrder: 0 }],
})
const v = (version: string, createdAt: number, notes: string | null = null): VersionForExport => ({
  id: `id-${version}`,
  workspaceId: 'w',
  collectionId: 'c',
  version,
  notes,
  folderCount: 0,
  requestCount: 1,
  createdAt,
  snapshot: snap(`C ${version}`),
})

describe('latestVersion', () => {
  it('is the highest semver, pre-releases included', () => {
    expect(latestVersion([])).toBeNull()
    expect(latestVersion([{ version: '1.2.0' }, { version: '1.10.0' }, { version: '1.9.9' }])).toBe('1.10.0')
    expect(latestVersion([{ version: '1.2.0' }, { version: '2.0.0-beta.1' }])).toBe('2.0.0-beta.1')
    expect(latestVersion([{ version: '2.0.0-beta.1' }, { version: '2.0.0' }])).toBe('2.0.0')
    expect(latestVersion([{ version: 'garbage' }])).toBeNull()
  })
})

describe('buildSlingerBlock', () => {
  const versions = [v('1.10.0', 1_700_000_300, 'ten'), v('1.2.0', 1_700_000_100, 'two'), v('1.9.0', 1_700_000_200)]

  it('lists versions oldest semver first with ISO dates and snapshots', () => {
    const block = buildSlingerBlock({ collectionId: 'c', versions, includeSnapshots: true, appVersion: '0.3.2', now: new Date('2026-09-25T10:00:00Z') })
    expect(block).toMatchObject({ formatVersion: 1, exportedAt: '2026-09-25T10:00:00.000Z', app: 'Slinger 0.3.2', collectionId: 'c', includesSnapshots: true })
    expect(block.versions.map((x) => x.version)).toEqual(['1.2.0', '1.9.0', '1.10.0'])
    expect(block.versions[0]).toEqual({ version: '1.2.0', notes: 'two', createdAt: isoFromSeconds(1_700_000_100), folderCount: 0, requestCount: 1, snapshot: snap('C 1.2.0') })
    expect(block.versions[1]!.notes).toBeNull()
  })

  it('metadata only: no snapshots at all', () => {
    const block = buildSlingerBlock({ collectionId: 'c', versions: versions.map(({ snapshot: _s, ...rest }) => rest), includeSnapshots: false, appVersion: '1' })
    expect(block.includesSnapshots).toBe(false)
    expect(block.versions).toHaveLength(3)
    for (const x of block.versions) expect(x).not.toHaveProperty('snapshot')
  })

  it('refuses to silently drop a snapshot that was not loaded', () => {
    expect(() => buildSlingerBlock({ collectionId: 'c', versions: [{ ...v('1.0.0', 1), snapshot: null }], includeSnapshots: true, appVersion: '1' })).toThrow(/1\.0\.0/)
  })

  it('round-trips epoch seconds through ISO exactly', () => {
    for (const s of [0, 1, 1_700_000_123, 4_102_444_800]) expect(Date.parse(isoFromSeconds(s)) / 1000).toBe(s)
  })
})

describe('buildPostmanCollection with version history', () => {
  const collection = { id: 'c', workspaceId: 'w', name: 'enat uat', createdAt: 0, updatedAt: 0, version: 1 }

  it('writes info.version and info._slinger after the standard fields', () => {
    const slinger = buildSlingerBlock({ collectionId: 'c', versions: [v('1.2.0', 5)], includeSnapshots: true, appVersion: '0.3.2' })
    const out = buildPostmanCollection({ collection, folders: [], requests: [], version: '1.2.0', slinger })
    expect(Object.keys(out.info)).toEqual(['_postman_id', 'name', 'version', 'schema', '_slinger'])
    expect(out.info.version).toBe('1.2.0')
    expect(out.info._slinger).toBe(slinger)
  })

  it('without history the info block is unchanged', () => {
    const out = buildPostmanCollection({ collection, folders: [], requests: [] })
    expect(Object.keys(out.info)).toEqual(['_postman_id', 'name', 'schema'])
  })
})

describe('buildPostmanEnvironment options', () => {
  const vars = [
    { key: 'host', value: 'https://x.test', isSecret: false },
    { key: 'token', value: 's3cret', isSecret: true },
  ]
  it('writes the Postman envelope (id, exported_at, exported_using) and blanks secrets by default', () => {
    const env = buildPostmanEnvironment('Prod', vars, { id: 'e1', exportedAt: '2026-09-25T10:00:00.000Z', exportedUsing: 'Slinger/0.3.2' })
    expect(env).toEqual({
      id: 'e1',
      name: 'Prod',
      values: [
        { key: 'host', value: 'https://x.test', type: 'default', enabled: true },
        { key: 'token', value: '', type: 'secret', enabled: true },
      ],
      _postman_variable_scope: 'environment',
      _postman_exported_at: '2026-09-25T10:00:00.000Z',
      _postman_exported_using: 'Slinger/0.3.2',
    })
  })
  it('includes secret values only on explicit opt-in', () => {
    const env = buildPostmanEnvironment('Prod', vars, { includeSecretValues: true })
    expect(env.values[1]).toEqual({ key: 'token', value: 's3cret', type: 'secret', enabled: true })
  })
})
