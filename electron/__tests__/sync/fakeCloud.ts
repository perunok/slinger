/**
 * In-process fake of the Slinger cloud server (protocol v2) for engine tests. It is ALSO the executable
 * specification of the server behaviour the desktop engine relies on (docs/SYNC_DESIGN.md sections 3, 7, 14):
 * everything below that the real server must do is intentional.
 *
 * Real HTTP on 127.0.0.1 so the whole desktop path (CloudHttp, CloudAuth, CloudApi) is exercised.
 * Endpoints: auth (device flow, refresh with single-use rotation + reuse detection, logout), /v1/me,
 * workspaces (list/get/publish), sync client registration, push, pull, snapshot.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

export type ResourceType = 'collection' | 'folder' | 'request' | 'environment' | 'environment_variable' | 'collection_version'
export type Role = 'owner' | 'admin' | 'editor' | 'viewer'
type Payload = Record<string, unknown>

const TYPE_ORDER: ResourceType[] = ['collection', 'environment', 'folder', 'request', 'environment_variable', 'collection_version']
const METHOD_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

interface Entity {
  type: ResourceType
  id: string
  ws: string
  version: number
  data: Payload
}
interface LogOp {
  operation_id: string
  workspace_id: string
  resource_type: ResourceType
  resource_id: string
  op: 'upsert' | 'delete'
  resulting_version: number
  payload: Payload
  occurred_at: string
  checkpoint: number
  client_id: string | null
}
interface Workspace {
  id: string
  name: string
  slug: string
  checkpoint: number
  log: LogOp[]
  members: Map<string, Role>
  seen: Map<string, LogOp> // operation_id -> log entry (idempotency)
}
interface User {
  id: string
  email: string
  displayName: string
}

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  body: string
  userId: string | null
  /** Filled once answered (for debugging). */
  response?: string
}

/** Rejections are returned per operation exactly like the real server. */
class Reject extends Error {
  constructor(
    public code: 'sync_conflict' | 'not_found' | 'invalid_request' | 'conflict',
    message: string,
    public currentVersion: number | null = null,
    /** Structured reason of protocol v2 (branch on this, `code` is the legacy class). */
    public reason: string = '',
    public extra: { current_payload?: Payload | null; conflicting_resource_id?: string | null } = {},
  ) {
    super(message)
    if (!this.reason) {
      this.reason = code === 'sync_conflict' ? 'version_mismatch' : code === 'not_found' ? 'not_found' : code === 'invalid_request' ? (/exceeds/.test(message) ? 'too_large' : 'invalid') : 'id_in_use'
    }
  }
}

export interface Fault {
  /** Matches `METHOD /path` (regex or exact string). */
  match: RegExp | string
  /** 'status': answer with `status` without applying; 'drop-after': apply the request, then kill the connection; 'drop-before': kill without applying. */
  action: 'status' | 'drop-after' | 'drop-before'
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** How many matching requests to affect (default 1). */
  times?: number
  /** Let this many matching requests through untouched first. */
  skip?: number
}

export interface FakeCloudOptions {
  protocolVersion?: number
  pushBodyLimit?: number
  accessTtlMs?: number
}

export class FakeCloud {
  readonly users = new Map<string, User>()
  readonly workspaces = new Map<string, Workspace>()
  readonly entities = new Map<string, Entity>() // key = id (ids are globally unique)
  readonly requests: RecordedRequest[] = []
  readonly faults: Fault[] = []
  protocolVersion: number
  pushBodyLimit: number
  accessTtlMs: number
  baseUrl = ''
  private server!: Server
  private sockets = new Set<import('node:net').Socket>()
  private clients = new Map<string, string>() // client id -> user id
  private access = new Map<string, string>() // access token -> user id
  private refresh = new Map<string, { userId: string; used: boolean; revoked: boolean }>()
  private deviceFlows = new Map<string, { userCode: string; userId: string | null; expiresAt: number }>()

  constructor(opts: FakeCloudOptions = {}) {
    this.protocolVersion = opts.protocolVersion ?? 2
    this.pushBodyLimit = opts.pushBodyLimit ?? 8 * 1024 * 1024
    this.accessTtlMs = opts.accessTtlMs ?? 15 * 60_000
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res))
    this.server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise((r) => this.server.close(r))
  }

  // ---- test helpers ------------------------------------------------------------------------------------------------

  createUser(email: string, displayName = email): User {
    const u = { id: randomUUID(), email, displayName }
    this.users.set(u.id, u)
    return u
  }
  /** Direct token pair (skips the device flow). */
  issueTokens(userId: string): { accessToken: string; refreshToken: string } {
    return { accessToken: this.newAccess(userId), refreshToken: this.newRefresh(userId) }
  }
  createWorkspace(name: string, ownerId: string): Workspace {
    const w: Workspace = { id: randomUUID(), name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${this.workspaces.size}`, checkpoint: 0, log: [], members: new Map([[ownerId, 'owner']]), seen: new Map() }
    this.workspaces.set(w.id, w)
    return w
  }
  setRole(wsId: string, userId: string, role: Role | null): void {
    const w = this.workspaces.get(wsId)!
    if (role) w.members.set(userId, role)
    else w.members.delete(userId)
  }
  deleteWorkspace(wsId: string): void {
    this.workspaces.delete(wsId)
    for (const [k, e] of this.entities) if (e.ws === wsId) this.entities.delete(k)
  }
  approveDevice(userCode: string, userId: string): void {
    for (const f of this.deviceFlows.values()) if (f.userCode === userCode) f.userId = userId
  }
  revokeAllRefreshTokens(userId: string): void {
    for (const t of this.refresh.values()) if (t.userId === userId) t.revoked = true
  }
  expireAccessTokens(): void {
    this.access.clear()
  }
  /** Live entities of a workspace of one type (sorted by id). */
  live(wsId: string, type?: ResourceType): Entity[] {
    return [...this.entities.values()].filter((e) => e.ws === wsId && (!type || e.type === type)).sort((a, b) => (a.id < b.id ? -1 : 1))
  }
  entity(id: string): Entity | undefined {
    return this.entities.get(id)
  }
  /** Simulates another writer (dashboard/REST) editing an entity: bumps the version and logs an upsert. */
  restUpsert(wsId: string, type: ResourceType, id: string, data: Payload): number {
    const w = this.workspaces.get(wsId)!
    const cur = this.entities.get(id)
    const merged = { ...(cur?.data ?? {}), ...data }
    const version = (cur?.version ?? 0) + 1
    this.entities.set(id, { type, id, ws: wsId, version, data: merged })
    this.record(w, null, randomUUID(), type, id, 'upsert', version, this.wire(this.entities.get(id)!))
    return version
  }
  restDelete(wsId: string, type: ResourceType, id: string): void {
    const w = this.workspaces.get(wsId)!
    const cur = this.entities.get(id)
    if (!cur) return
    this.cascadeDelete(w, cur, null, null)
  }
  /** Simulates a server reset: every registered sync client id becomes unknown. */
  forgetClients(): void {
    this.clients.clear()
  }
  clearRecorded(): void {
    this.requests.length = 0
  }
  requestsTo(path: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => path.test(r.path))
  }

  // ---- tokens ------------------------------------------------------------------------------------------------------

  private newAccess(userId: string): string {
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor((Date.now() + this.accessTtlMs) / 1000), jti: randomUUID() })).toString('base64url')
    const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.sig`
    this.access.set(token, userId)
    return token
  }
  private newRefresh(userId: string): string {
    const t = `rt_${randomUUID()}${randomUUID()}`
    this.refresh.set(t, { userId, used: false, revoked: false })
    return t
  }

  // ---- HTTP plumbing -----------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    for await (const c of req) {
      size += (c as Buffer).length
      if (size <= this.pushBodyLimit + 1) chunks.push(c as Buffer)
      else tooBig = true
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'
    const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? null
    const userId = auth ? (this.access.get(auth) ?? null) : null
    const key = `${method} ${url.pathname}`
    const recorded: RecordedRequest = { method, path: url.pathname, query: url.searchParams, body, userId }
    this.requests.push(recorded)

    const fault0 = this.faults.find((f) => (typeof f.match === 'string' ? f.match === key : f.match.test(key)))
    let fault: Fault | undefined = fault0
    if (fault && (fault.skip ?? 0) > 0) {
      fault.skip = (fault.skip ?? 0) - 1
      fault = undefined
    } else if (fault) {
      fault.times = (fault.times ?? 1) - 1
      if (fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1)
      if (fault.action === 'status') return this.send(res, fault.status ?? 500, fault.body ?? { error: { code: 'internal_error', message: 'injected failure' } }, fault.headers)
      if (fault.action === 'drop-before') return void req.socket.destroy()
    }
    const respond = (status: number, payload: unknown, headers?: Record<string, string>) => {
      recorded.response = JSON.stringify(payload)
      if (fault?.action === 'drop-after') return void req.socket.destroy()
      this.send(res, status, payload, headers)
    }
    if (tooBig && /\/sync\/push$/.test(url.pathname)) {
      return respond(413, { error: { code: 'invalid_request', message: 'request body too large' } })
    }
    try {
      const out = this.route(method, url, body ? (JSON.parse(body) as Payload) : {}, userId)
      respond(out.status ?? 200, out.body)
    } catch (err) {
      if (err instanceof HttpError) return respond(err.status, { error: { code: err.code, message: err.message, details: {}, request_id: 'req' } })
      console.error('[fakeCloud]', err)
      respond(500, { error: { code: 'internal_error', message: String(err) } })
    }
  }

  private send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  }

  private route(method: string, url: URL, body: Payload, userId: string | null): { status?: number; body: unknown } {
    const path = url.pathname
    // -------- auth (public)
    if (method === 'POST' && path === '/v1/auth/device/start') {
      const deviceCode = `dc_${randomUUID()}`
      const userCode = `SL-${Math.floor(1000 + Math.random() * 9000)}`
      this.deviceFlows.set(deviceCode, { userCode, userId: null, expiresAt: Date.now() + 600_000 })
      return { body: { device_code: deviceCode, user_code: userCode, verification_uri: `${this.baseUrl}/device`, verification_uri_complete: `${this.baseUrl}/device?code=${userCode}`, expires_in: 600, interval: 1 } }
    }
    if (method === 'POST' && path === '/v1/auth/device/poll') {
      const f = this.deviceFlows.get(String(body.device_code))
      if (!f || f.expiresAt < Date.now()) return { body: { status: 'expired' } }
      if (!f.userId) return { body: { status: 'pending' } }
      this.deviceFlows.delete(String(body.device_code))
      const u = this.users.get(f.userId)!
      return { body: { status: 'approved', access_token: this.newAccess(u.id), refresh_token: this.newRefresh(u.id), expires_in: this.accessTtlMs / 1000, token_type: 'Bearer', user: { id: u.id, email: u.email, display_name: u.displayName, platform_role: 'user' } } }
    }
    if (method === 'POST' && path === '/v1/auth/refresh') {
      const t = this.refresh.get(String(body.refresh_token))
      if (!t || t.revoked) throw new HttpError(401, 'unauthenticated', 'invalid refresh token')
      if (t.used) {
        this.revokeAllRefreshTokens(t.userId) // reuse detection
        throw new HttpError(401, 'unauthenticated', 'refresh token reuse detected')
      }
      t.used = true
      return { body: { access_token: this.newAccess(t.userId), refresh_token: this.newRefresh(t.userId), expires_in: this.accessTtlMs / 1000, token_type: 'Bearer' } }
    }
    if (method === 'POST' && path === '/v1/auth/logout') {
      const t = this.refresh.get(String(body.refresh_token))
      if (t) t.revoked = true
      return { body: { ok: true } }
    }
    // -------- authenticated
    if (!userId) throw new HttpError(401, 'unauthenticated', 'missing or invalid access token')
    if (method === 'GET' && path === '/v1/me') {
      const u = this.users.get(userId)!
      return { body: { user: { id: u.id, email: u.email, display_name: u.displayName, platform_role: 'user' }, workspace_memberships: [] } }
    }
    if (method === 'POST' && path === '/v1/sync/clients/register') {
      const id = `cl_${randomUUID()}`
      this.clients.set(id, userId)
      return { status: 201, body: { client: { client_id: id, registered_at: new Date().toISOString() }, protocol_version: this.protocolVersion, features: ['sort_order', 'snapshot', 'collection_version', 'secret_metadata'] } }
    }
    if (method === 'GET' && path === '/v1/workspaces') {
      const items = [...this.workspaces.values()].filter((w) => w.members.has(userId)).map((w) => this.wsDto(w, userId))
      return { body: { items, page: { next_cursor: null, has_more: false } } }
    }
    if (method === 'POST' && path === '/v1/workspaces/publish') {
      const client = (body.client as { client_id?: string } | undefined)?.client_id
      if (client && this.clients.get(client) !== userId) throw new HttpError(400, 'invalid_request', 'unknown client_id; register the client first')
      const name = String((body.local_workspace as { name: string }).name)
      const w = this.createWorkspace(name, userId)
      return { status: 201, body: { workspace: this.wsDto(w, userId), membership: { role: 'owner' }, sync_bootstrap: { client_id: client ?? 'cl_new', checkpoint: w.checkpoint } } }
    }
    const m = /^\/v1\/workspaces\/([^/]+)(?:\/(sync\/(?:push|pull|snapshot)))?$/.exec(path)
    if (m) {
      const w = this.workspaces.get(decodeURIComponent(m[1]!))
      const role = w?.members.get(userId)
      if (!w || !role) throw new HttpError(w ? 403 : 404, w ? 'workspace_access_denied' : 'not_found', w ? 'not a member of this workspace' : 'workspace not found')
      if (!m[2] && method === 'GET') return { body: { workspace: this.wsDto(w, userId), membership: { role } } }
      if (m[2] === 'sync/push' && method === 'POST') {
        if (role === 'viewer') throw new HttpError(403, 'forbidden', 'viewers cannot push')
        return { body: this.push(w, userId, body) }
      }
      if (m[2] === 'sync/pull' && method === 'GET') return { body: this.pull(w, userId, url.searchParams) }
      if (m[2] === 'sync/snapshot' && method === 'GET') return { body: this.snapshot(w, userId, url.searchParams) }
    }
    throw new HttpError(404, 'not_found', `no route ${method} ${path}`)
  }

  private wsDto(w: Workspace, userId: string) {
    return { id: w.id, slug: w.slug, name: w.name, description: '', owner_user_id: '', visibility: 'private', default_role_for_requests: 'viewer', host_mode: 'cloud', created_at: '', updated_at: '', version: 1, role: w.members.get(userId) }
  }

  // ---- sync: push --------------------------------------------------------------------------------------------------

  private assertClient(clientId: unknown, userId: string): string {
    if (typeof clientId !== 'string' || this.clients.get(clientId) !== userId) throw new HttpError(400, 'invalid_request', 'unknown client_id; register the client first')
    return clientId
  }

  private push(w: Workspace, userId: string, body: Payload) {
    const clientId = this.assertClient(body.client_id, userId)
    const ops = (body.operations as Array<Record<string, unknown>>) ?? []
    if (ops.length > 500) throw new HttpError(400, 'invalid_request', 'too many operations (max 500)')
    const accepted: Array<{ operation_id: string; resource_id: string; resulting_version: number }> = []
    const rejected: Array<{ operation_id: string; resource_id: string; code: string; reason: string; message: string; current_version: number | null; current_payload: Payload | null; conflicting_resource_id: string | null }> = []
    for (const op of ops) {
      const opId = String(op.operation_id)
      const rid = String(op.resource_id)
      const replay = w.seen.get(opId)
      if (replay) {
        accepted.push({ operation_id: opId, resource_id: replay.resource_id, resulting_version: replay.resulting_version })
        continue
      }
      try {
        const version = this.applyOp(w, clientId, {
          operation_id: opId, resource_type: op.resource_type as ResourceType, resource_id: rid, op: op.op as 'upsert' | 'delete',
          base_version: Number(op.base_version ?? 0), payload: (op.payload as Payload) ?? {},
        })
        accepted.push({ operation_id: opId, resource_id: rid, resulting_version: version })
      } catch (err) {
        if (!(err instanceof Reject)) throw err
        rejected.push({ operation_id: opId, resource_id: rid, code: err.code, reason: err.reason, message: err.message, current_version: err.currentVersion, current_payload: err.extra.current_payload ?? null, conflicting_resource_id: err.extra.conflicting_resource_id ?? null })
      }
    }
    return { accepted, rejected, checkpoint: w.checkpoint }
  }

  private record(w: Workspace, clientId: string | null, opId: string, type: ResourceType, id: string, op: 'upsert' | 'delete', version: number, payload: Payload): void {
    w.checkpoint += 1
    const entry: LogOp = { operation_id: opId, workspace_id: w.id, resource_type: type, resource_id: id, op, resulting_version: version, payload, occurred_at: new Date().toISOString(), checkpoint: w.checkpoint, client_id: clientId }
    w.log.push(entry)
    w.seen.set(opId, entry)
  }

  /** Wire payload of an entity as pulled/snapshotted (secret values are never present). */
  wireOf(e: Entity): Payload {
    return this.wire(e)
  }

  /** Wire payload as pulled: secret values are never present. */
  private wire(e: Entity): Payload {
    const d = e.data
    switch (e.type) {
      case 'collection':
      case 'environment':
        return { name: d.name }
      case 'folder':
        return { collection_id: d.collection_id, parent_folder_id: d.parent_folder_id ?? null, name: d.name, sort_order: d.sort_order ?? 0 }
      case 'request':
        return { collection_id: d.collection_id, folder_id: d.folder_id ?? null, name: d.name, method: d.method, url: d.url, document_json: d.document_json, sort_order: d.sort_order ?? 0 }
      case 'environment_variable':
        return { environment_id: d.environment_id, key: d.key, value: d.is_secret ? null : (d.value ?? ''), is_secret: d.is_secret === true }
      case 'collection_version':
        return { collection_id: d.collection_id, semver: d.semver, notes: d.notes ?? null, snapshot_json: d.snapshot_json, folder_count: d.folder_count, request_count: d.request_count, created_at: d.created_at }
    }
  }

  private validate(type: ResourceType, p: Payload, partialOk: boolean): void {
    const str = (k: string, max: number, opt = partialOk) => {
      if (p[k] === undefined) {
        if (opt) return
        throw new Reject('invalid_request', `invalid payload: ${k} required`)
      }
      if (typeof p[k] !== 'string' || (p[k] as string).trim().length < 1 || (p[k] as string).length > max) throw new Reject('invalid_request', `invalid payload: ${k} must be 1-${max} characters`)
    }
    const bytes = (k: string, max: number) => {
      if (typeof p[k] === 'string' && Buffer.byteLength(p[k] as string, 'utf8') > max) throw new Reject('invalid_request', `${k} exceeds ${max} bytes (too_large)`)
    }
    switch (type) {
      case 'collection':
      case 'environment':
      case 'folder':
        str('name', 200)
        break
      case 'request':
        str('name', 500)
        str('method', 32)
        if (typeof p.method === 'string' && !METHOD_RE.test(p.method)) throw new Reject('invalid_request', 'method must be an HTTP token')
        if (p.url !== undefined && typeof p.url !== 'string') throw new Reject('invalid_request', 'url must be a string')
        bytes('document_json', 900_000)
        break
      case 'environment_variable':
        if (p.key !== undefined && (typeof p.key !== 'string' || p.key.length > 128 || !KEY_RE.test(p.key))) throw new Reject('invalid_request', 'invalid payload: key')
        if (p.is_secret === true && p.value != null) throw new Reject('invalid_request', 'secret values must not be synced')
        if (typeof p.value === 'string' && p.value.length > 65_536) throw new Reject('invalid_request', 'value too long')
        break
      case 'collection_version':
        bytes('snapshot_json', 8_000_000)
        break
    }
    if (p.sort_order !== undefined && (!Number.isInteger(p.sort_order) || (p.sort_order as number) < 0)) throw new Reject('invalid_request', 'sort_order must be an integer >= 0')
  }

  private applyOp(w: Workspace, clientId: string, op: { operation_id: string; resource_type: ResourceType; resource_id: string; op: 'upsert' | 'delete'; base_version: number; payload: Payload }): number {
    const id = op.resource_id
    const cur = [...this.entities.values()].find((e) => e.id === id && e.ws === w.id && e.type === op.resource_type) ?? null
    if (cur && op.resource_type === 'collection_version' && op.op === 'upsert') {
      // Immutable resource: an identical re-send is an idempotent success, anything else is refused.
      if (JSON.stringify(sortKeys(this.wire(cur))) === JSON.stringify(sortKeys(op.payload))) return cur.version
      throw new Reject('conflict', 'collection versions are immutable', null, 'immutable')
    }
    if (cur) {
      if (op.base_version !== cur.version) throw new Reject('sync_conflict', 'base_version does not match the server version; pull and retry', cur.version, 'version_mismatch', { current_payload: this.wire(cur) })
    } else if (op.op === 'upsert' && op.base_version > 0) {
      throw new Reject('sync_conflict', 'resource no longer exists on the server (deleted); pull and retry', null, 'not_found')
    }
    if (op.op === 'delete') {
      if (!cur) throw new Reject('not_found', `${op.resource_type} not found`)
      this.cascadeDelete(w, cur, clientId, op.operation_id)
      return cur.version
    }
    const p = op.payload
    if (cur) {
      this.validate(op.resource_type, p, true)
      const next = { ...cur.data, ...p }
      this.checkRefs(w, op.resource_type, next, cur)
      const version = cur.version + 1
      const stored: Entity = { ...cur, version, data: this.normalize(op.resource_type, next) }
      this.entities.set(id, stored)
      this.record(w, clientId, op.operation_id, op.resource_type, id, 'upsert', version, this.wire(stored))
      return version
    }
    this.validate(op.resource_type, p, false)
    if (this.entities.has(id)) throw new Reject('conflict', 'resource id is already in use', null, 'id_in_use')
    this.checkRefs(w, op.resource_type, p, null)
    const stored: Entity = { type: op.resource_type, id, ws: w.id, version: 1, data: this.normalize(op.resource_type, p) }
    if (op.resource_type === 'collection_version') {
      // Immutable: identical replays are idempotent successes elsewhere; here: label clash with another id.
    }
    this.entities.set(id, stored)
    this.record(w, clientId, op.operation_id, op.resource_type, id, 'upsert', 1, this.wire(stored))
    return 1
  }

  private normalize(type: ResourceType, p: Payload): Payload {
    if (type === 'environment_variable') {
      const secret = p.is_secret === true
      return { ...p, is_secret: secret, value: secret ? null : (p.value ?? '') }
    }
    return p
  }

  /** Parent existence/consistency + unique keys + cycle checks (mirrors content.ts). */
  private checkRefs(w: Workspace, type: ResourceType, d: Payload, cur: Entity | null): void {
    const find = (t: ResourceType, id: unknown) => (typeof id === 'string' ? [...this.entities.values()].find((e) => e.id === id && e.ws === w.id && e.type === t) : undefined)
    switch (type) {
      case 'folder': {
        const col = find('collection', d.collection_id)
        if (!col) throw new Reject('not_found', 'collection not found')
        if (cur && d.collection_id !== cur.data.collection_id) throw new Reject('invalid_request', 'a folder cannot move between collections')
        if (d.parent_folder_id) {
          if (d.parent_folder_id === cur?.id) throw new Reject('invalid_request', 'a folder cannot be its own parent')
          const parent = find('folder', d.parent_folder_id)
          if (!parent || parent.data.collection_id !== d.collection_id) throw new Reject('invalid_request', 'parent_folder_id does not exist in this collection')
          if (cur) {
            let walk: unknown = parent.data.parent_folder_id
            for (let i = 0; walk && i < 1000; i++) {
              if (walk === cur.id) throw new Reject('invalid_request', 'folder cannot be moved into its own descendant')
              walk = find('folder', walk)?.data.parent_folder_id
            }
          }
        }
        break
      }
      case 'request': {
        if (!find('collection', d.collection_id)) throw new Reject('not_found', 'collection not found')
        if (d.folder_id) {
          const f = find('folder', d.folder_id)
          if (!f || f.data.collection_id !== d.collection_id) throw new Reject('invalid_request', 'folder_id does not exist in this collection')
        }
        break
      }
      case 'environment_variable': {
        if (!find('environment', d.environment_id)) throw new Reject('not_found', 'environment not found')
        if (cur && d.environment_id !== cur.data.environment_id) throw new Reject('invalid_request', "a variable's environment cannot change")
        const clash = [...this.entities.values()].find((e) => e.type === 'environment_variable' && e.ws === w.id && e.id !== cur?.id && e.data.environment_id === d.environment_id && e.data.key === d.key)
        if (clash) throw new Reject('conflict', 'a resource with these unique values already exists', null, 'duplicate_key', { conflicting_resource_id: clash.id })
        break
      }
      case 'collection_version': {
        if (!find('collection', d.collection_id)) throw new Reject('not_found', 'collection not found')
        if (cur) throw new Reject('conflict', 'collection versions are immutable', null, 'immutable')
        const clash = [...this.entities.values()].find((e) => e.type === 'collection_version' && e.ws === w.id && e.data.collection_id === d.collection_id && e.data.semver === d.semver)
        if (clash) throw new Reject('conflict', 'a resource with these unique values already exists', null, 'duplicate_key', { conflicting_resource_id: clash.id })
        break
      }
    }
  }

  /** Hard delete with logged cascades (children first, tombstones with fresh operation ids). */
  private cascadeDelete(w: Workspace, root: Entity, clientId: string | null, opId: string | null): void {
    const inWs = () => [...this.entities.values()].filter((e) => e.ws === w.id)
    const removeAndLog = (e: Entity, id: string) => {
      this.entities.delete(e.id)
      this.record(w, clientId, id, e.type, e.id, 'delete', e.version, {})
    }
    const kids: Entity[] = []
    if (root.type === 'collection') {
      const all = inWs().filter((e) => e.data.collection_id === root.id)
      kids.push(...all.filter((e) => e.type === 'collection_version'), ...all.filter((e) => e.type === 'request'), ...this.foldersDeepFirst(all.filter((e) => e.type === 'folder')))
    } else if (root.type === 'environment') {
      kids.push(...inWs().filter((e) => e.type === 'environment_variable' && e.data.environment_id === root.id))
    } else if (root.type === 'folder') {
      const folders: Entity[] = []
      const collect = (fid: string) => {
        for (const f of inWs().filter((e) => e.type === 'folder' && e.data.parent_folder_id === fid)) {
          folders.push(f)
          collect(f.id)
        }
      }
      collect(root.id)
      const ids = new Set([root.id, ...folders.map((f) => f.id)])
      kids.push(...inWs().filter((e) => e.type === 'request' && ids.has(String(e.data.folder_id))), ...this.foldersDeepFirst(folders))
    }
    for (const k of kids) removeAndLog(k, randomUUID())
    removeAndLog(root, opId ?? randomUUID())
  }

  private foldersDeepFirst(folders: Entity[]): Entity[] {
    const depth = (f: Entity): number => {
      let d = 0
      let cur: Entity | undefined = f
      while (cur && cur.data.parent_folder_id && d < 1000) {
        cur = folders.find((x) => x.id === cur!.data.parent_folder_id)
        d++
      }
      return d
    }
    return [...folders].sort((a, b) => depth(b) - depth(a) || (a.id < b.id ? -1 : 1))
  }

  // ---- sync: pull / snapshot ---------------------------------------------------------------------------------------

  private pull(w: Workspace, userId: string, q: URLSearchParams) {
    this.assertClient(q.get('client_id'), userId)
    const after = Number(q.get('after_checkpoint') ?? 0)
    const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 200)))
    const rows = w.log.filter((o) => o.checkpoint > after).slice(0, limit + 1)
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return {
      operations: page.map(({ client_id: _c, ...op }) => op),
      checkpoint: page.length ? page[page.length - 1]!.checkpoint : after,
      has_more: hasMore,
    }
  }

  /** Current entities (no tombstones) in type order then id; `checkpoint` is read before the first page and echoed via the cursor. */
  private snapshot(w: Workspace, userId: string, q: URLSearchParams) {
    this.assertClient(q.get('client_id'), userId)
    const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 200)))
    const cursorRaw = q.get('cursor')
    const cursor = cursorRaw ? (JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8')) as { c: number; t: number; a: string }) : { c: w.checkpoint, t: 0, a: '' }
    const entities: Array<{ resource_type: ResourceType; resource_id: string; version: number; payload: Payload }> = []
    let t = cursor.t
    let after = cursor.a
    let next: string | null = null
    outer: for (; t < TYPE_ORDER.length; t++) {
      const rows = this.live(w.id, TYPE_ORDER[t]).filter((e) => e.id > after)
      for (const e of rows) {
        if (entities.length === limit) {
          const last = entities[entities.length - 1]!
          next = Buffer.from(JSON.stringify({ c: cursor.c, t: TYPE_ORDER.indexOf(last.resource_type), a: last.resource_id })).toString('base64url')
          break outer
        }
        entities.push({ resource_type: e.type, resource_id: e.id, version: e.version, payload: this.wire(e) })
      }
      after = ''
    }
    return { checkpoint: cursor.c, entities, next_cursor: next }
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
  return v
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
