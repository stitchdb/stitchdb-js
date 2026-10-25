import type { Fetch } from './lib/types'

/**
 * Offline-first sync (`stitchdb.offline()`): a local copy of the rows the signed-in user may see in the tables that
 * sync (Studio › Database › Offline sync). Reads come from the local copy, writes apply locally at once and are queued;
 * the queue is pushed and changes are pulled whenever the device is online.
 */

/** Where the local copy lives. `get/set/delete/entries` over string keys; values are JSON-serialisable. */
export interface OfflineStore {
  get(key: string): Promise<any>
  set(key: string, value: any): Promise<void>
  delete(key: string): Promise<void>
  entries(prefix: string): Promise<[string, any][]>
  clear?(): Promise<void>
}

export type OfflineOptions = {
  /** Tables to keep offline (default: every table that syncs). */
  tables?: string[]
  /** `'indexeddb'` (default in browsers), `'memory'` (default elsewhere) or your own store. */
  store?: 'indexeddb' | 'memory' | OfflineStore
  /** Name of the local database (default `stitchdb-offline-<project ref>`). Use one per signed-in user. */
  name?: string
  /** Sync every … ms while online (default 30000; 0 = only when you call sync() and on reconnect). */
  interval?: number
  /** Rows per pull request (default 500). */
  batch?: number
}

export type SyncStatus = { online: boolean; syncing: boolean; pending: number; lastSyncAt: string | null; error: string | null }
export type ConflictEvent<Row = any> = { table: string; pk: Record<string, unknown>; local: Row | null; server: Row | null; status: 'conflict' | 'rejected'; message?: string }
type Mutation = { id: string; table: string; op: 'upsert' | 'delete'; row?: any; pk?: any; base: number | null; at: string }
type Listener = (...args: any[]) => void

export class OfflineError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OfflineError'
    this.status = status
  }
}

export class MemoryStore implements OfflineStore {
  private m = new Map<string, any>()
  async get(k: string) { return this.m.has(k) ? JSON.parse(this.m.get(k)) : undefined }
  async set(k: string, v: any) { this.m.set(k, JSON.stringify(v)) }
  async delete(k: string) { this.m.delete(k) }
  async entries(prefix: string): Promise<[string, any][]> { return [...this.m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)]) }
  async clear() { this.m.clear() }
}

export class IndexedDBStore implements OfflineStore {
  private db: Promise<IDBDatabase>
  constructor(name: string) {
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1)
      r.onupgradeneeded = () => r.result.createObjectStore('kv')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  get(k: string) { return this.tx('readonly', (s) => s.get(k)) }
  async set(k: string, v: any) { await this.tx('readwrite', (s) => s.put(v, k)) }
  async delete(k: string) { await this.tx('readwrite', (s) => s.delete(k)) }
  async entries(prefix: string): Promise<[string, any][]> {
    const range = IDBKeyRange.bound(prefix, prefix + '￿')
    const [keys, values] = await Promise.all([this.tx('readonly', (s) => s.getAllKeys(range)), this.tx('readonly', (s) => s.getAll(range))])
    return keys.map((k, i) => [String(k), values[i]])
  }
  async clear() { await this.tx('readwrite', (s) => s.clear()) }
}

const rid = (n = 16) => {
  const a = new Uint8Array(n)
  globalThis.crypto.getRandomValues(a)
  return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('')
}

export class OfflineTable<Row extends Record<string, any> = Record<string, any>> {
  constructor(private c: OfflineClient, readonly name: string) {}
  /** Every local row. */
  all(): Row[] { return [...this.c._rows(this.name).values()].map((r) => r.row) }
  /** One row by primary key (an object, or the value for a one-column key). */
  get(pk: unknown): Row | null { return this.c._rows(this.name).get(this.c._key(this.name, pk))?.row ?? null }
  /** Local rows that match. */
  where(fn: (row: Row) => boolean): Row[] { return this.all().filter(fn) }
  /** Insert or update a row locally and queue it for the server. The row must include its primary key. */
  upsert(row: Partial<Row>): Promise<void> { return this.c._write(this.name, 'upsert', row) }
  /** Delete a row locally and on the server. */
  delete(pk: unknown): Promise<void> { return this.c._write(this.name, 'delete', pk) }
  /** Called with the table's rows after every local or synced change. Returns an unsubscribe function. */
  subscribe(fn: (rows: Row[]) => void): () => void { return this.c.on('change', (t: string) => { if (t === this.name) fn(this.all()) }) }
}

export class OfflineClient {
  readonly ready: Promise<void>
  private store!: OfflineStore
  private meta: { client: string; cursors: Record<string, number>; next: number } = { client: '', cursors: {}, next: 1 }
  private pk: Record<string, string[]> = {}
  private data = new Map<string, Map<string, { row: any; seq: number }>>()
  private queue: Mutation[] = []
  private listeners = new Map<string, Set<Listener>>()
  private timer: any = null
  private running: Promise<void> | null = null
  private closed = false
  status: SyncStatus = { online: typeof navigator === 'undefined' || navigator.onLine !== false, syncing: false, pending: 0, lastSyncAt: null, error: null }

  constructor(private url: string, private fetch: Fetch, private options: OfflineOptions, defaultName: string) {
    const s = options.store
    this.store = s && typeof s === 'object' ? s : (s === 'indexeddb' || (!s && typeof indexedDB !== 'undefined')) ? new IndexedDBStore(options.name || defaultName) : new MemoryStore()
    this.ready = this.open()
  }

  private async req(path: string, body?: unknown) {
    const res = await this.fetch(this.url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new OfflineError(json.message || `Sync failed (${res.status})`, res.status)
    return json
  }

  private async open() {
    const m = await this.store.get('m')
    if (m) this.meta = m
    if (!this.meta.client) { this.meta.client = rid(); await this.store.set('m', this.meta) }
    this.pk = (await this.store.get('pk')) || {}
    for (const [k, v] of await this.store.entries('r/')) {
      const [, table, key] = k.match(/^r\/([^/]+)\/(.*)$/s) || []
      if (table) this._rows(table).set(key, v)
    }
    this.queue = (await this.store.entries('q/')).map(([, v]) => v).sort((a, b) => a._n - b._n)
    this.status.pending = this.queue.length
    try { await this.loadTables() } catch (e: any) { if (!Object.keys(this.pk).length) this.setStatus({ online: false, error: e.message }) }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', this.onOnline)
      window.addEventListener('offline', this.onOffline)
    }
    const every = this.options.interval ?? 30000
    if (every > 0) this.timer = setInterval(() => { if (this.status.online) this.sync().catch(() => {}) }, every)
    this.sync().catch(() => {})
  }
  private onOnline = () => { this.setStatus({ online: true }); this.sync().catch(() => {}) }
  private onOffline = () => this.setStatus({ online: false })

  private async loadTables() {
    const { tables } = await this.req('/tables')
    const want = this.options.tables
    const pk: Record<string, string[]> = {}
    for (const t of tables) if (!want || want.includes(t.name)) pk[t.name] = t.pk
    for (const name of want || []) if (!pk[name]) throw new OfflineError(`${name} does not sync. Turn it on in Studio › Database › Offline sync.`, 404)
    this.pk = pk
    await this.store.set('pk', pk)
  }

  /** @internal */
  _rows(table: string) {
    let m = this.data.get(table)
    if (!m) this.data.set(table, (m = new Map()))
    return m
  }
  /** @internal */
  _key(table: string, v: unknown): string {
    const cols = this.pk[table]
    if (!cols) throw new OfflineError(`${table} is not synced offline`, 404)
    const o: any = v !== null && typeof v === 'object' ? v : { [cols[0]]: v }
    return JSON.stringify(cols.map((c) => { if (o[c] === undefined || o[c] === null) throw new OfflineError(`${table}: the primary key column ${c} is missing`, 400); return o[c] }))
  }
  private pkObj(table: string, v: any) {
    const o: any = v !== null && typeof v === 'object' ? v : { [this.pk[table][0]]: v }
    return Object.fromEntries(this.pk[table].map((c) => [c, o[c]]))
  }

  table<Row extends Record<string, any> = Record<string, any>>(name: string): OfflineTable<Row> { return new OfflineTable<Row>(this, name) }

  /** @internal */
  async _write(table: string, op: 'upsert' | 'delete', v: any) {
    await this.ready
    const key = this._key(table, v), rows = this._rows(table), cur = rows.get(key)
    const m: Mutation & { _n: number } = { id: `${this.meta.client}.${this.meta.next++}`, _n: this.meta.next, table, op, base: cur?.seq ?? null, at: new Date().toISOString(),
      ...(op === 'upsert' ? { row: { ...(cur?.row || {}), ...v } } : { pk: this.pkObj(table, v) }) }
    if (op === 'upsert') { rows.set(key, { row: m.row, seq: cur?.seq ?? 0 }); await this.store.set(`r/${table}/${key}`, rows.get(key)) }
    else { rows.delete(key); await this.store.delete(`r/${table}/${key}`) }
    this.queue.push(m)
    await this.store.set(`q/${String(m._n).padStart(12, '0')}`, m)
    await this.store.set('m', this.meta)
    this.setStatus({ pending: this.queue.length })
    this.emit('change', table)
    if (this.status.online) this.sync().catch(() => {})
  }

  /** Push queued writes, then pull until up to date. Resolves when done; rejects if the server can't be reached. */
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.running) return this.running.then(() => (this.queue.length ? this.sync() : undefined))
    this.running = this.run().finally(() => { this.running = null })
    return this.running
  }

  private async run() {
    await this.ready.catch(() => {})
    this.setStatus({ syncing: true })
    try {
      if (!Object.keys(this.pk).length) await this.loadTables()
      await this.pushAll()
      await this.pullAll()
      this.setStatus({ online: true, syncing: false, error: null, lastSyncAt: new Date().toISOString() })
    } catch (e: any) {
      this.setStatus({ syncing: false, online: !(e instanceof TypeError) && e.status !== 0, error: e.message })
      throw e
    }
  }

  private async pushAll() {
    while (this.queue.length) {
      const batch = this.queue.slice(0, 200)
      const { results } = await this.req('/push', { client: this.meta.client, mutations: batch.map(({ _n, ...m }: any) => m) })
      for (const [i, r] of results.entries()) {
        const m = batch[i] as Mutation & { _n: number }
        const key = this._key(m.table, m.row || m.pk), rows = this._rows(m.table)
        const later = this.queue.some((q) => q !== m && q.table === m.table && this._key(q.table, q.row || q.pk) === key)
        if (r.status === 'conflict' || r.status === 'rejected') {
          this.emit('conflict', { table: m.table, pk: r.pk || this.pkObj(m.table, m.row || m.pk), local: m.row ?? null, server: r.row ?? null, status: r.status, message: r.message } as ConflictEvent)
        }
        if (!later) await this.put(m.table, key, r.row ? { row: r.row, seq: r.seq ?? 0 } : null)
        else if (r.seq) for (const q of this.queue) if (q !== m && q.table === m.table && this._key(q.table, q.row || q.pk) === key) q.base = r.seq
        this.queue.splice(this.queue.indexOf(m), 1)
        await this.store.delete(`q/${String(m._n).padStart(12, '0')}`)
        this.emit('change', m.table)
      }
      this.setStatus({ pending: this.queue.length })
    }
  }

  private async put(table: string, key: string, v: { row: any; seq: number } | null) {
    const rows = this._rows(table)
    if (v) { rows.set(key, v); await this.store.set(`r/${table}/${key}`, v) }
    else { rows.delete(key); await this.store.delete(`r/${table}/${key}`) }
  }

  private async pullAll() {
    for (let more = true; more;) {
      const tables = Object.fromEntries(Object.keys(this.pk).map((t) => [t, this.meta.cursors[t] || 0]))
      const r = await this.req('/pull', { tables, limit: this.options.batch ?? 500 })
      for (const t of r.reset || []) {
        for (const k of [...this._rows(t).keys()]) await this.put(t, k, null)
        this.meta.cursors[t] = 0
      }
      for (const [t, list] of Object.entries(r.changes || {}) as [string, any[]][]) {
        const pending = new Set(this.queue.filter((q) => q.table === t).map((q) => this._key(t, q.row || q.pk)))
        for (const ch of list) {
          const key = this._key(t, ch.pk)
          if (pending.has(key)) continue // the local write wins until it is pushed
          await this.put(t, key, ch.op === 'u' ? { row: ch.row, seq: ch.seq } : null)
        }
        if (list.length || (r.reset || []).includes(t)) this.emit('change', t)
      }
      Object.assign(this.meta.cursors, r.cursors || {})
      await this.store.set('m', this.meta)
      more = !!r.more
    }
  }

  /** Events: `change` (table), `status` (SyncStatus), `conflict` (ConflictEvent: your write lost or was refused). */
  on(event: 'change' | 'status' | 'conflict', fn: Listener): () => void {
    let s = this.listeners.get(event)
    if (!s) this.listeners.set(event, (s = new Set()))
    s.add(fn)
    return () => s!.delete(fn)
  }
  private emit(event: string, ...args: any[]) { for (const fn of this.listeners.get(event) || []) try { fn(...args) } catch {} }
  private setStatus(p: Partial<SyncStatus>) { this.status = { ...this.status, ...p }; this.emit('status', this.status) }

  /** Stop syncing. With `{ clear: true }` also delete the local copy and the queued writes (e.g. on sign-out). */
  async close({ clear = false } = {}) {
    this.closed = true
    clearInterval(this.timer)
    if (typeof window !== 'undefined' && window.removeEventListener) { window.removeEventListener('online', this.onOnline); window.removeEventListener('offline', this.onOffline) }
    await this.running?.catch(() => {})
    if (clear) await this.store.clear?.()
  }
}
