/**
 * Collaborative documents: keep a Yjs document in sync between everyone who has it open, stored in your project with
 * history. Turn it on in Studio › Realtime › Collaborative docs. Who may open and edit a document is row level
 * security on `collab.documents` (by default: the creator owns it and shares it with people as viewer or editor).
 *
 * ```js
 * import * as Y from 'yjs'
 * const collab = stitchdb.collab({ Y })
 * const ydoc = new Y.Doc()
 * const room = await collab.open('plan-2026', ydoc, { create: { title: 'Plan 2026' } })
 * ydoc.getText('body').insert(0, 'Hello')        // sent to everyone in the document
 * room.setPresence({ name: 'Ann', cursor: 4 })    // cursors and names, not stored
 * room.on('presence', (peers) => drawCursors(peers))
 * ```
 * Works with any editor binding that takes a Y.Doc (TipTap, Lexical, ProseMirror, CodeMirror, Monaco, BlockNote…).
 * Changes made while offline are kept and sent when the connection is back.
 */

/** The parts of the `yjs` module the provider uses: pass `import * as Y from 'yjs'`. */
export interface YModule {
  Doc: new (opts?: any) => YDocLike
  applyUpdate(doc: YDocLike, update: Uint8Array, origin?: unknown): void
  encodeStateAsUpdate(doc: YDocLike): Uint8Array
  mergeUpdates(updates: Uint8Array[]): Uint8Array
}
export interface YDocLike {
  on(event: 'update', fn: (update: Uint8Array, origin: unknown) => void): void
  off(event: 'update', fn: (update: Uint8Array, origin: unknown) => void): void
}

export interface CollabOptions {
  /** The yjs module (`import * as Y from 'yjs'`). */
  Y: YModule
  /** A WebSocket constructor (default: the global one). */
  WebSocket?: typeof WebSocket
  /** Compact the stored history into one update once a document has this many (default 200). */
  compactAfter?: number
}
export interface OpenOptions {
  /** Create the document if it does not exist yet (your INSERT policy on collab.documents decides who may). */
  create?: boolean | { title?: string }
}
export type CollabStatus = 'connecting' | 'connected' | 'offline'
export interface Peer { client: string; state: Record<string, unknown> }
export interface SnapshotInfo { id: number; seq: number; size_bytes: number; label: string | null; auto: boolean; created_at: string }

export interface DocumentInfo {
  id: string; title: string | null; owner_id: string | null; org_id: string | null; metadata: Record<string, unknown>
  size_bytes: number; created_at: string; updated_at: string
  /** What the signed-in user is on this document: 'owner', 'editor', 'viewer', or null when another policy lets them in. */
  access: 'owner' | 'editor' | 'viewer' | null
}
export class CollabError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'CollabError' }
}

type Handler = (...a: any[]) => void
const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000))); return btoa(s) }
const fromB64 = (s: string) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
const jwtExp = (t: string | null) => { try { return t ? JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0 : 0 } catch { return 0 } }

/** One open document. */
export class CollabRoom {
  /** True when the signed-in user may edit (your UPDATE policy on collab.documents); otherwise edits stay local. */
  write = false
  /** True once the stored document has been loaded into the Y.Doc. */
  synced = false
  /** Other people in the document with their presence state, by connection id. */
  readonly peers = new Map<string, Record<string, unknown>>()
  /** @internal */ seq = 0
  /** @internal */ pending: Uint8Array[] = []
  /** @internal */ inflight = new Map<number, Uint8Array>()
  /** @internal */ presence: Record<string, unknown> | null = null
  /** @internal */ joined = false
  private handlers: Record<string, Handler[]> = {}
  private onUpdate: (u: Uint8Array, origin: unknown) => void
  private readyWait: { resolve: () => void; reject: (e: Error) => void } | null = null
  /** @internal */ readonly ready: Promise<void>

  constructor(private c: CollabClient, readonly id: string, readonly doc: YDocLike, /** @internal */ readonly opts: OpenOptions) {
    this.ready = new Promise((resolve, reject) => { this.readyWait = { resolve, reject } })
    this.onUpdate = (u, origin) => { if (origin !== this) { this.pending.push(u); this.c._flush(this) } }
    doc.on('update', this.onUpdate)
  }
  on(event: 'presence', fn: (peers: Map<string, Record<string, unknown>>) => void): () => void
  on(event: 'synced' | 'status', fn: (v: any) => void): () => void
  on(event: 'error', fn: (e: CollabError) => void): () => void
  on(event: string, fn: Handler) { (this.handlers[event] ||= []).push(fn); return () => { this.handlers[event] = this.handlers[event].filter((h) => h !== fn) } }
  /** @internal */ emit(event: string, ...a: any[]) { for (const h of this.handlers[event] || []) h(...a) }
  /** Changes not yet saved on the server (made offline, or waiting for the answer). */
  get unsaved() { return this.pending.length + this.inflight.size }
  /** Your cursor, selection, name or colour, shown to the others in the document. `null` hides you. */
  setPresence(state: Record<string, unknown> | null) { this.presence = state; this.c._send({ t: 'presence', doc: this.id, state }, this) }
  /** Save the document as it is now in its history. */
  async snapshot(label?: string): Promise<number> { const r = await this.c._http('POST', `/docs/${encodeURIComponent(this.id)}/snapshots`, { label }); return r.id }
  /** The document's history, newest first (automatic hourly snapshots and the ones you took). */
  async snapshots(): Promise<SnapshotInfo[]> { return (await this.c._http('GET', `/docs/${encodeURIComponent(this.id)}/snapshots`)).snapshots }
  /** A snapshot as a new, separate Y.Doc (read it, show a diff, or copy parts back into the live document). */
  async loadSnapshot(id: number): Promise<YDocLike> {
    const r = await this.c._http('GET', `/docs/${encodeURIComponent(this.id)}/snapshots/${id}`)
    const d = new this.c.Y.Doc()
    for (const u of r.updates) this.c.Y.applyUpdate(d, fromB64(u))
    return d
  }
  /** Stop syncing this document (the Y.Doc keeps its content). */
  close() { this.doc.off('update', this.onUpdate); this.c._leave(this) }
  /** @internal */ _apply(b64: string) { this.c.Y.applyUpdate(this.doc, fromB64(b64), this) }
  /** @internal */ _joined(m: any) {
    this.write = !!m.write; this.seq = m.seq; this.joined = true
    for (const u of m.updates) this._apply(u)
    this.peers.clear(); for (const p of m.peers || []) this.peers.set(p.client, p.state)
    // Anything sent before the connection dropped and not confirmed goes again (applying an update twice is harmless).
    for (const u of this.inflight.values()) this.pending.unshift(u)
    this.inflight.clear()
    if (!this.write && this.pending.length) this.emit('error', new CollabError('You can read this document but not edit it; your changes were not saved', 'forbidden'))
    if (!this.write) this.pending = []
    if (this.presence) this.c._send({ t: 'presence', doc: this.id, state: this.presence }, this)
    const first = !this.synced
    this.synced = true
    this.emit('synced', true); this.emit('presence', this.peers)
    if (first) { this.readyWait?.resolve(); this.readyWait = null }
    this.c._flush(this)
    if (this.write && m.count > this.c.compactAfter) this.c._send({ t: 'compact', doc: this.id, upto: this.seq, data: toB64(this.c.Y.encodeStateAsUpdate(this.doc)) }, this)
  }
  /** @internal */ _fail(e: CollabError) { if (this.readyWait) { this.readyWait.reject(e); this.readyWait = null; this.doc.off('update', this.onUpdate) } else this.emit('error', e) }
}

/** The connection (one WebSocket for all open documents); made with `stitchdb.collab({ Y })`. */
export class CollabClient {
  /** @internal */ readonly Y: YModule
  /** @internal */ readonly compactAfter: number
  status: CollabStatus = 'offline'
  private rooms = new Map<string, CollabRoom>()
  private ws: WebSocket | null = null
  private ready = false
  private closed = false
  private retry = 0
  private timer: any = null
  private refresh: any = null
  private nextId = 1
  private WS: typeof WebSocket

  constructor(private wsUrl: string, private httpUrl: string, private apikey: string, private getToken: () => Promise<string | null>, private fetch: typeof globalThis.fetch, opts: CollabOptions) {
    if (!opts?.Y?.applyUpdate) throw new Error("stitchdb.collab({ Y }): pass the yjs module, e.g. import * as Y from 'yjs'")
    this.Y = opts.Y
    this.compactAfter = opts.compactAfter ?? 200
    this.WS = opts.WebSocket ?? (globalThis as any).WebSocket
  }

  /** Open a document and load it into `doc`; resolves once the stored content is in. */
  async open(id: string, doc: YDocLike, opts: OpenOptions = {}): Promise<CollabRoom> {
    if (this.rooms.has(id)) throw new Error(`${id} is already open`)
    const room = new CollabRoom(this, id, doc, opts)
    this.rooms.set(id, room)
    if (this.ready) this.join(room); else this.connect()
    try { await room.ready } catch (e) { this.rooms.delete(id); throw e }
    return room
  }
  /** The documents the signed-in user can open, most recently edited first. */
  async list(opts: { limit?: number } = {}): Promise<DocumentInfo[]> { return (await this._http('GET', `/docs?limit=${opts.limit ?? 50}`)).documents }
  /** Who a document is shared with. */
  async members(id: string): Promise<{ user_id: string; role: 'viewer' | 'editor'; created_at: string }[]> { return (await this._http('GET', `/docs/${encodeURIComponent(id)}/members`)).members }
  /** Share a document with a user as viewer or editor (by default only its owner may). Changes the role if already shared. */
  async share(id: string, userId: string, role: 'viewer' | 'editor' = 'editor'): Promise<void> { await this._http('POST', `/docs/${encodeURIComponent(id)}/members`, { user_id: userId, role }) }
  /** Stop sharing a document with a user (the owner, or the user leaving it themselves). */
  async unshare(id: string, userId: string): Promise<void> { await this._http('DELETE', `/docs/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`) }
  /** Close every document and the connection. */
  close() {
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.refresh)
    for (const r of [...this.rooms.values()]) r.close()
    this.ws?.close(); this.ws = null
  }

  private setStatus(s: CollabStatus) { if (this.status === s) return; this.status = s; for (const r of this.rooms.values()) r.emit('status', s) }
  private async token() { const t = await this.getToken(); return t && t !== this.apikey ? t : null }
  private connect() {
    if (this.ws || this.closed) return
    this.setStatus('connecting')
    const ws = new this.WS(this.wsUrl)
    this.ws = ws
    ws.onopen = async () => { this.retry = 0; ws.send(JSON.stringify({ t: 'auth', apikey: this.apikey, token: await this.token() })) }
    ws.onmessage = (ev) => this.message(JSON.parse(String(ev.data)))
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null; this.ready = false; clearTimeout(this.refresh)
      for (const r of this.rooms.values()) { r.joined = false; r.peers.clear(); r.emit('presence', r.peers) }
      this.setStatus('offline')
      if (this.closed || !this.rooms.size) return
      if (ev.code === 4029) for (const r of this.rooms.values()) r._fail(new CollabError(ev.reason || 'Too many connections', 'too_many_connections'))
      const wait = Math.min(30000, 500 * 2 ** this.retry++) * (0.5 + Math.random() / 2)
      this.timer = setTimeout(() => this.connect(), wait)
    }
  }
  private join(room: CollabRoom) {
    const create = room.opts.create ? (typeof room.opts.create === 'object' ? room.opts.create : {}) : undefined
    this._send({ t: 'join', doc: room.id, since: room.synced ? room.seq : 0, create })
  }
  private message(m: any) {
    const room = m.doc ? this.rooms.get(m.doc) : undefined
    switch (m.t) {
      case 'ready': {
        this.ready = true; this.setStatus('connected')
        for (const r of this.rooms.values()) this.join(r)
        // Send a fresh token before the current one expires (the server closes the connection when it does).
        clearTimeout(this.refresh)
        this.token().then((t) => {
          const exp = jwtExp(t)
          if (exp) this.refresh = setTimeout(async () => { this._send({ t: 'auth', apikey: this.apikey, token: await this.token() }) }, Math.max(5000, exp * 1000 - Date.now() - 60000))
        })
        return
      }
      case 'joined': return room?._joined(m)
      case 'update': if (room) { room._apply(m.data); room.seq = Math.max(room.seq, m.seq) } return
      case 'ack': if (room) { room.inflight.delete(m.id); room.seq = Math.max(room.seq, m.seq) } return
      case 'presence': if (room) { if (m.state == null) room.peers.delete(m.client); else room.peers.set(m.client, m.state); room.emit('presence', room.peers) } return
      case 'left': if (room && m.reason) { room.joined = false; this.rooms.delete(room.id); room.emit('error', new CollabError(m.reason, 'forbidden')) } return
      case 'error': {
        const e = new CollabError(m.message, m.code)
        if (room && !room.synced) { this.rooms.delete(room.id); return room._fail(e) }
        if (room) { if (m.id && room.inflight.has(m.id)) { const u = room.inflight.get(m.id)!; room.inflight.delete(m.id); if (m.code === 'rate_limited') { room.pending.unshift(u); setTimeout(() => this._flush(room), 1000) } } return room.emit('error', e) }
        if (m.code === 'unauthorized' || /token|API key/i.test(m.message)) for (const r of this.rooms.values()) r._fail(e)
        return
      }
    }
  }
  /** @internal */ _send(m: any, room?: CollabRoom) { if (this.ws && this.ready && (!room || room.joined || m.t === 'join')) this.ws.send(JSON.stringify(m)) }
  /** @internal */ _flush(room: CollabRoom) {
    if (room.joined && !room.write) room.pending = [] // read only: edits stay local
    if (!this.ready || !room.joined || !room.write || !room.pending.length) return
    const u = room.pending.length === 1 ? room.pending[0] : this.Y.mergeUpdates(room.pending)
    room.pending = []
    const id = this.nextId++
    room.inflight.set(id, u)
    this._send({ t: 'update', doc: room.id, data: toB64(u), id }, room)
  }
  /** @internal */ _leave(room: CollabRoom) {
    if (this.rooms.get(room.id) !== room) return
    this._send({ t: 'leave', doc: room.id }, room)
    this.rooms.delete(room.id)
  }
  /** @internal */ async _http(method: string, path: string, body?: unknown) {
    const t = await this.token()
    const res = await this.fetch(this.httpUrl + path, { method, headers: { apikey: this.apikey, ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new CollabError(j.message || `HTTP ${res.status}`, res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : 'http_' + res.status)
    return j
  }
}
