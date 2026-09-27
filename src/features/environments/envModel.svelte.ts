/**
 * State + autosave orchestration for the variables of one owner at a time: an environment (the default backend),
 * a collection's variables or the workspace's globals (see varBackends.ts). `environmentId` is the owner id.
 * Secrets: a row only ever holds plaintext the user typed or explicitly revealed.
 */
import { errorInfo } from '../../lib/ipc'
import {
  bulkEligible, diffBulk, duplicateKeys, findDuplicates, isBlank, newRow, parseBulk, rowIssue, serializeBulk, summarizeStatus,
  valueToSend, type BulkParse, type Row,
} from './envLogic'
import { SaveQueue, type FlushResult } from './saveQueue'
import { environmentBackend, type VarBackend, type VarRecord } from './varBackends'

/** Queue key of a pending bulk replace (backends with `replace`). */
const BULK_KEY = '__bulk__'

export interface FocusRequest {
  rid: string
  field: 'key' | 'value'
}

function fromRecord(ownerId: string, v: VarRecord): Row {
  return newRow(ownerId, {
    id: v.id, key: v.key, value: v.isSecret ? '' : (v.value ?? ''), isSecret: v.isSecret, serverSecret: v.isSecret, secretMissing: v.isSecret && v.secretMissing,
    enabled: v.enabled,
  })
}

export class EnvModel {
  environmentId = $state<string | null>(null)
  rows = $state<Row[]>([])
  loading = $state(false)
  loadError = $state<string | null>(null)
  focusRequest = $state<FocusRequest | null>(null)
  revealing = $state<Record<string, boolean>>({})
  revealError = $state<Record<string, string>>({})
  bulkMode = $state(false)
  bulkText = $state('')
  /** Why the bulk text could not be applied (beyond line errors), e.g. a name that is a secret in the table. */
  bulkError = $state<string | null>(null)
  #bulkBase = ''
  readonly backend: VarBackend
  #tick = $state(0)
  #token = 0
  readonly queue: SaveQueue

  duplicates = $derived(findDuplicates(this.rows))
  duplicateNames = $derived(duplicateKeys(this.rows))
  secretCount = $derived(this.rows.filter((r) => !r.deleted && (r.isSecret || r.serverSecret)).length)
  bulkParse = $derived<BulkParse>(parseBulk(this.bulkText))
  bulkDirty = $derived(this.bulkMode && this.bulkText !== this.#bulkBase)
  status = $derived.by(() => {
    void this.#tick
    const c = this.queue.counts()
    if (this.bulkDirty) c.dirty++
    return summarizeStatus(c)
  })

  constructor(debounceMs = 600, backend: VarBackend = environmentBackend) {
    this.backend = backend
    this.queue = new SaveQueue({
      debounceMs,
      save: (rid) => this.#save(rid),
      block: (rid) => this.issueOf(rid),
      onchange: () => void this.#tick++,
    })
  }

  issueOf(rid: string): string | null {
    if (rid === BULK_KEY) return this.rows.some((r) => rowIssue(r, this.duplicates)) ? 'Fix the rows with problems first' : null
    const r = this.rows.find((x) => x.rid === rid)
    return r ? rowIssue(r, this.duplicates) : null
  }
  stateOf(rid: string) {
    void this.#tick
    return this.queue.stateOf(rid)
  }
  errorOf(rid: string) {
    void this.#tick
    return this.queue.errorOf(rid)
  }

  // ---- loading ----------------------------------------------------------

  async load(envId: string): Promise<void> {
    const token = ++this.#token
    this.environmentId = envId
    this.loading = true
    this.loadError = null
    this.queue.discardAll()
    this.bulkMode = false
    this.rows = []
    try {
      const vars = await this.backend.list(envId)
      if (token !== this.#token) return
      this.rows = [...vars.map((v) => fromRecord(envId, v)), newRow(envId)]
    } catch (e) {
      if (token === this.#token) this.loadError = errorInfo(e).message
    } finally {
      if (token === this.#token) this.loading = false
    }
  }

  /** Flushes edits of the current environment, then loads another. Returns false if flushing failed. */
  async select(envId: string): Promise<boolean> {
    if (envId === this.environmentId) return true
    if (this.environmentId && !(await this.flush()).ok) return false
    await this.load(envId)
    return true
  }

  /** Applies pending bulk edits, then saves everything. */
  async flush(): Promise<FlushResult> {
    if (this.bulkDirty) {
      if (!this.applyBulk()) return { ok: false, failed: ['bulk'] }
    }
    return this.queue.flush()
  }

  /** Drops all unsaved edits (the user chose to discard). */
  discard(): void {
    this.queue.discardAll()
    this.bulkText = this.#bulkBase
  }

  dispose(): void {
    void this.flush().finally(() => this.queue.dispose())
  }

  // ---- editing ----------------------------------------------------------

  #row(rid: string): Row | undefined {
    return this.rows.find((r) => r.rid === rid)
  }

  #afterEdit(row: Row): void {
    if (isBlank(row)) this.queue.discard(row.rid)
    else this.queue.touch(row.rid)
    const last = this.rows[this.rows.length - 1]
    if (this.environmentId && (!last || !isBlank(last))) this.rows.push(newRow(this.environmentId))
    this.queue.recheck()
  }

  edit(rid: string, patch: { key?: string; value?: string }): void {
    const row = this.#row(rid)
    if (!row || row.deleted) return
    if (patch.key !== undefined) row.key = patch.key
    if (patch.value !== undefined) {
      row.value = patch.value
      if (row.isSecret) row.secretTouched = true
    }
    this.#afterEdit(row)
  }

  toggleSecret(rid: string): void {
    const row = this.#row(rid)
    if (!row || row.deleted || !this.backend.secrets) return
    row.isSecret = !row.isSecret
    row.revealed = false
    this.#afterEdit(row)
  }

  /** Collection variables / globals: a disabled variable is kept but does not resolve. */
  toggleEnabled(rid: string): void {
    const row = this.#row(rid)
    if (!row || row.deleted || !this.backend.enabledColumn) return
    row.enabled = !row.enabled
    this.#afterEdit(row)
  }

  remove(rid: string): void {
    const row = this.#row(rid)
    if (!row) return
    // A create may be in flight (no id yet): keep the row so the follow-up save can delete it.
    if (!row.id && this.queue.stateOf(rid) !== 'saving') {
      this.queue.discard(rid)
      this.rows = this.rows.filter((r) => r.rid !== rid)
      if (this.environmentId && !this.rows.some(isBlank)) this.rows.push(newRow(this.environmentId))
    } else {
      row.deleted = true
      this.queue.touch(rid, { immediate: true })
    }
    this.queue.recheck()
  }

  /** Explicit reveal (IPC) for a stored, untouched secret; otherwise just shows what was typed. */
  async reveal(rid: string): Promise<void> {
    const row = this.#row(rid)
    if (!row) return
    if (row.revealed) {
      row.revealed = false
      if (!row.secretTouched) row.value = ''
      return
    }
    if (!row.id || !row.serverSecret || row.secretTouched) {
      row.revealed = true
      return
    }
    this.revealing[rid] = true
    delete this.revealError[rid]
    try {
      const plain = await this.backend.reveal(row.id)
      const cur = this.#row(rid)
      if (cur && !cur.secretTouched) {
        cur.value = plain
        cur.revealed = true
      }
    } catch (e) {
      this.revealError[rid] = errorInfo(e).message
    } finally {
      delete this.revealing[rid]
    }
  }

  /** Adds (or focuses) a row for a variable name coming from the "Create variable" popover. */
  addNamed(name: string): void {
    const existing = this.rows.find((r) => !r.deleted && r.key === name)
    if (existing) {
      this.focusRequest = { rid: existing.rid, field: 'value' }
      return
    }
    const blank = this.rows.find(isBlank)
    const row = blank ?? newRow(this.environmentId ?? '')
    row.key = name
    if (!blank) this.rows.push(row)
    this.#afterEdit(row)
    this.focusRequest = { rid: row.rid, field: 'value' }
  }

  // ---- bulk -------------------------------------------------------------

  enterBulk(): void {
    this.#bulkBase = this.bulkText = serializeBulk(this.rows)
    this.bulkMode = true
  }

  /** Applies bulk text to the rows (create/update/delete by key). Returns false if the text has errors. */
  applyBulk(): boolean {
    if (this.bulkParse.errors.length > 0) return false
    if (this.backend.replace) return this.#applyBulkReplace()
    const d = diffBulk(this.rows, this.bulkParse.entries)
    for (const u of d.update) this.edit(u.rid, { value: u.value })
    for (const c of d.create) {
      const blank = this.rows.find(isBlank)
      const row = blank ?? newRow(this.environmentId ?? '')
      row.key = c.key
      row.value = c.value
      if (!blank) this.rows.push(row)
      this.#afterEdit(row)
    }
    for (const rid of d.remove) this.remove(rid)
    this.#bulkBase = this.bulkText = serializeBulk(this.rows)
    return true
  }

  /**
   * Bulk replace (collection variables, globals): the list becomes the text's variables in the text's order,
   * followed by the rows the text cannot show (secrets, disabled, multi-line), saved with ONE replace call.
   */
  #applyBulkReplace(): boolean {
    const owner = this.environmentId ?? ''
    const eligible = this.rows.filter(bulkEligible)
    const kept = this.rows.filter((r) => !r.deleted && !isBlank(r) && !bulkEligible(r))
    const keptKeys = new Set(kept.map((r) => r.key))
    const clash = this.bulkParse.entries.find((e) => keptKeys.has(e.key))
    if (clash) {
      this.bulkError = `"${clash.key}" is a secret, disabled or multi-line variable: edit it in the table.`
      return false
    }
    this.bulkError = null
    const next: Row[] = []
    for (const e of this.bulkParse.entries) {
      const hit = eligible.find((r) => r.key === e.key && !next.includes(r))
      if (hit) {
        hit.value = e.value
        next.push(hit)
      } else next.push(newRow(owner, { key: e.key, value: e.value }))
    }
    next.push(...kept)
    // The replace saves every row: per-row saves of the old list are dropped (removed rows are deleted by it).
    for (const r of this.rows) this.queue.discard(r.rid)
    this.rows = [...next, newRow(owner)]
    this.queue.touch(BULK_KEY, { immediate: true })
    this.#bulkBase = this.bulkText = serializeBulk(this.rows)
    return true
  }

  async #saveBulk(): Promise<void> {
    const owner = this.environmentId
    if (!owner || !this.backend.replace) return
    // Rows still in the list (edits made meanwhile are included; deleted rows are left out).
    const rows = this.rows.filter((r) => !r.deleted && !isBlank(r))
    const res = await this.backend.replace(
      owner,
      rows.map((r) => ({ key: r.key, value: valueToSend(r), enabled: r.enabled, isSecret: r.isSecret })),
    )
    for (const rec of res) {
      const cur = this.rows.find((r) => r.key === rec.key && !r.deleted)
      if (!cur) continue
      cur.id = rec.id
      cur.serverSecret = rec.isSecret
      if (cur.isSecret && !cur.revealed) {
        cur.value = ''
        cur.secretTouched = false
      }
    }
    this.backend.changed(owner)
  }

  exitBulk(): void {
    this.bulkMode = false
  }

  get bulkExcluded(): number {
    return this.rows.filter((r) => !r.deleted && !isBlank(r) && !bulkEligible(r)).length
  }

  // ---- saving -----------------------------------------------------------

  async #save(rid: string): Promise<void> {
    if (rid === BULK_KEY) return this.#saveBulk()
    const row = this.#row(rid)
    if (!row) return
    const envId = row.envId
    if (row.deleted) {
      if (row.id) await this.backend.remove(row.id)
      this.rows = this.rows.filter((r) => r.rid !== rid)
      this.queue.discard(rid)
      this.backend.changed(envId)
      return
    }
    const sent = { key: row.key, value: row.value, isSecret: row.isSecret }
    const res = await this.backend.upsert(envId, {
      key: row.key,
      value: valueToSend(row),
      isSecret: row.isSecret,
      enabled: row.enabled,
      variableId: row.id,
    })
    // Merge only server-owned fields; never overwrite what the user may have typed meanwhile.
    const cur = this.#row(rid)
    if (cur) {
      cur.id = res.id
      cur.serverSecret = res.isSecret
      cur.secretMissing = res.isSecret && res.secretMissing
      if (cur.isSecret && cur.value === sent.value && !cur.revealed) {
        cur.value = ''
        cur.secretTouched = false
      } else if (cur.isSecret && cur.value === sent.value) {
        cur.secretTouched = false
      }
    }
    this.backend.changed(envId)
  }
}
