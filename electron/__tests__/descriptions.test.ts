import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { runMigrations } from '../db/migrate'
import { toErrorPayload } from '../lib/errors'
import { assertExternalUrl } from '../services/externalUrl'
import { insertLink } from '../sync/linking'
import { buildPostmanCollection } from '../../src/lib/postman'
import { MIGRATIONS_DIR, makeEnv, scaffold, type TestEnv } from './helpers'

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
})
afterEach(() => env.cleanup())

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
const COLLECTION_MD = '# Payments API\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'

function payload() {
  return {
    info: { name: 'Docs', description: COLLECTION_MD, schema: SCHEMA },
    item: [
      {
        name: 'Markdown object',
        description: { content: '## Users\n\nAll *user* endpoints.', type: 'text/markdown' },
        item: [
          {
            name: 'Plain folder',
            description: { content: 'line 1\n  <b>not html</b>', type: 'text/plain' },
            item: [{ name: 'r1', request: { method: 'GET', url: 'http://x/1', description: { content: 'obj', type: 'text/plain' } } }],
          },
        ],
      },
      { name: 'No docs', item: [{ name: 'r2', request: { method: 'GET', url: 'http://x/2', description: 'Request **docs**' } }] },
      { name: 'Blank docs', description: '   ', item: [{ name: 'r3', request: 'http://x/3' }] },
    ],
  }
}

async function importDocs() {
  const text = JSON.stringify(payload())
  const imported = await env.api.importPostmanCollection(wsId, text)
  const folders = await env.api.listFolders(imported.collection.id)
  const byName = Object.fromEntries(folders.map((f) => [f.name, f]))
  return { imported, folders, byName }
}

describe('migration 0006 (descriptions)', () => {
  it('adds description columns to collections and folders and keeps existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slinger-mig-'))
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n < '0006')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
      const db = openDatabase(':memory:')
      runMigrations(db, dir)
      db.prepare("INSERT INTO workspaces (id, name, workspace_type, version, deleted, created_at, updated_at) VALUES ('w', 'W', 'personal', 1, 0, 1, 1)").run()
      db.prepare("INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES ('c', 'w', 'C', 1, 0, 1, 1)").run()
      cpSync(join(MIGRATIONS_DIR, '0006_descriptions.sql'), join(dir, '0006_descriptions.sql'))
      expect(runMigrations(db, dir)).toEqual(['0006_descriptions.sql'])
      expect(db.prepare('SELECT name, description, description_type FROM collections').all()).toEqual([{ name: 'C', description: null, description_type: null }])
      const cols = (db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toEqual(expect.arrayContaining(['description', 'description_type']))
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Postman import of collection and folder descriptions', () => {
  it('stores string and {content, type} descriptions with their shape; blank ones are dropped', async () => {
    const { imported, byName } = await importDocs()
    expect(imported.collection).toMatchObject({ description: COLLECTION_MD, descriptionType: null })
    expect(byName['Markdown object']).toMatchObject({ description: '## Users\n\nAll *user* endpoints.', descriptionType: 'text/markdown' })
    expect(byName['Plain folder']).toMatchObject({ description: 'line 1\n  <b>not html</b>', descriptionType: 'text/plain' })
    expect(byName['No docs']).toMatchObject({ description: null, descriptionType: null })
    expect(byName['Blank docs']).toMatchObject({ description: null, descriptionType: null })
  })

  it('keeps request descriptions verbatim in the document (string or object)', async () => {
    const { imported } = await importDocs()
    const docs = Object.fromEntries((await env.api.listRequests(imported.collection.id)).map((r) => [r.name, JSON.parse(r.documentJson)]))
    expect(docs.r1.description).toEqual({ content: 'obj', type: 'text/plain' })
    expect(docs.r2.description).toBe('Request **docs**')
  })

  it('exports every description back in its original shape (byte-faithful when untouched)', async () => {
    const { imported, folders } = await importDocs()
    const requests = await env.api.listRequests(imported.collection.id)
    const out = buildPostmanCollection({ collection: imported.collection, folders, requests })
    const src = payload()
    expect(JSON.stringify(out.info.description)).toBe(JSON.stringify(src.info.description))
    const [md, noDocs, blank] = out.item
    expect(JSON.stringify(md!.description)).toBe(JSON.stringify(src.item[0]!.description))
    const srcFolder = src.item[0]!.item![0]! as { description?: unknown }
    expect(JSON.stringify(md!.item![0]!.description)).toBe(JSON.stringify(srcFolder.description))
    expect(JSON.stringify(md!.item![0]!.item![0]!.request!.description)).toBe(JSON.stringify({ content: 'obj', type: 'text/plain' }))
    expect(noDocs).not.toHaveProperty('description')
    expect(noDocs!.item![0]!.request!.description).toBe('Request **docs**')
    expect(blank).not.toHaveProperty('description')
  })
})

describe('setCollectionDescription / setFolderDescription', () => {
  it('persists, keeps the stored type while there is text, and clears both on blank', async () => {
    const { imported, byName } = await importDocs()
    const plain = byName['Plain folder']!
    const edited = await env.api.setFolderDescription(plain.id, 'new plain text')
    expect(edited).toMatchObject({ description: 'new plain text', descriptionType: 'text/plain' })
    expect((await env.api.listFolders(imported.collection.id)).find((f) => f.id === plain.id)).toMatchObject({ description: 'new plain text' })
    expect(await env.api.setFolderDescription(plain.id, '  \n')).toMatchObject({ description: null, descriptionType: null })

    const c = await env.api.setCollectionDescription(imported.collection.id, '# New')
    expect(c).toMatchObject({ description: '# New', descriptionType: null })
    expect((await env.api.listCollections(wsId)).find((x) => x.id === c.id)).toMatchObject({ description: '# New' })
    expect(await env.api.setCollectionDescription(c.id, null)).toMatchObject({ description: null })
  })

  it('does not mark the collection or folder dirty for sync (local-only in v1)', async () => {
    const { imported, byName } = await importDocs()
    insertLink(env.core.db, {
      workspaceId: wsId, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'editor',
      clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
    })
    env.core.db.prepare('DELETE FROM sync_dirty').run()
    await env.api.setCollectionDescription(imported.collection.id, 'x')
    await env.api.setFolderDescription(byName['No docs']!.id, 'y')
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 0 })
  })

  it('is refused on read-only (viewer) workspaces', async () => {
    const { imported, byName } = await importDocs()
    insertLink(env.core.db, {
      workspaceId: wsId, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'viewer',
      clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
    })
    for (const write of [env.api.setCollectionDescription(imported.collection.id, 'x'), env.api.setFolderDescription(byName['No docs']!.id, 'y')]) {
      const err = await write.catch((e: unknown) => e)
      expect(toErrorPayload(err).code).toBe('read_only')
    }
  })

  it('validates its input', async () => {
    const { collection } = await scaffold(env)
    for (const bad of [42, {}, 'x'.repeat(5 * 1024 * 1024)]) {
      const err = await env.api.setCollectionDescription(collection.id, bad as never).catch((e: unknown) => e)
      expect(toErrorPayload(err).code).toBe('invalid_input')
    }
  })
})

describe('collection versions carry descriptions', () => {
  it('snapshots collection and folder descriptions and restores them (replace and copy)', async () => {
    const { imported, byName } = await importDocs()
    const cid = imported.collection.id
    const v = await env.api.createCollectionVersion({ collectionId: cid, version: '1.0.0' })
    const detail = await env.api.getCollectionVersion(v.id)
    expect(detail.snapshot).toMatchObject({ collectionDescription: COLLECTION_MD })
    expect(detail.snapshot).not.toHaveProperty('collectionDescriptionType')
    expect(detail.snapshot.folders.find((f) => f.name === 'Plain folder')).toMatchObject({ descriptionType: 'text/plain' })

    await env.api.setCollectionDescription(cid, 'changed')
    await env.api.setFolderDescription(byName['Plain folder']!.id, null)
    const restored = await env.api.restoreCollectionVersion(v.id, 'replace')
    expect(restored).toMatchObject({ description: COLLECTION_MD, descriptionType: null })
    expect((await env.api.listFolders(cid)).find((f) => f.name === 'Plain folder')).toMatchObject({
      description: 'line 1\n  <b>not html</b>',
      descriptionType: 'text/plain',
    })

    const copy = await env.api.restoreCollectionVersion(v.id, 'copy')
    expect(copy).toMatchObject({ description: COLLECTION_MD })
    expect((await env.api.listFolders(copy.id)).find((f) => f.name === 'Markdown object')).toMatchObject({ descriptionType: 'text/markdown' })
  })
})

describe('openExternalUrl policy', () => {
  it('allows http, https and mailto; refuses everything else', async () => {
    expect(assertExternalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(assertExternalUrl('mailto:dev@example.com')).toBe('mailto:dev@example.com')
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'slinger://x', 'vbscript:x', '#anchor', '/relative']) {
      expect(() => assertExternalUrl(bad), bad).toThrow()
    }
    await env.api.openExternalUrl('mailto:dev@example.com')
    expect(env.opened).toEqual(['mailto:dev@example.com'])
  })
})
