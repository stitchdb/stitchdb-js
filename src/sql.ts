/**
 * SQL over HTTP and WebSocket for edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy, Bun, Node ≥ 18): run
 * Postgres queries against a StitchDB project without a TCP connection.
 *
 * ```ts
 * import { createSql } from 'stitchdb-js/sql'
 *
 * const sql = createSql(env.STITCHDB_SQL_URL) // https://sdb_sql_...@<ref>.stitchdb.com (Studio › Database › Serverless SQL)
 * const todos = await sql`select * from todos where owner = ${userId} order by created_at desc limit 20`
 *
 * // Several statements in one transaction, in one HTTP request:
 * const [, [order]] = await sql.transaction([
 *   sql`update stock set left = left - 1 where sku = ${sku}`,
 *   sql`insert into orders (sku, buyer) values (${sku}, ${userId}) returning *`,
 * ])
 *
 * // Interactive transactions (read, decide, write) over a WebSocket session:
 * const db = await sql.connect()
 * await db.transaction(async (tx) => {
 *   const [acct] = await tx`select balance from accounts where id = ${id} for update`
 *   if (Number(acct.balance) < amount) throw new Error('Not enough money')
 *   await tx`update accounts set balance = balance - ${amount} where id = ${id}`
 * })
 * db.close()
 * ```
 *
 * The SQL key runs queries as the project's owner (like the connection string): keep it on the server, never in a
 * browser or an app. Values: booleans, int2/int4, float4/float8 and json/jsonb come as JavaScript values; int8,
 * numeric, dates and times come as the text Postgres prints (no precision is lost; convert them where you need to).
 * @module
 */

export type SqlValue = string | number | boolean | null | undefined | bigint | Date | Uint8Array | unknown[] | Record<string, unknown>

export interface SqlField { name: string; dataTypeID: number }
export interface SqlResult<R = Record<string, unknown>> { command: string; rowCount: number | null; fields: SqlField[]; rows: R[] }

export interface SqlOptions {
  /** A fetch to use (default: the global one). */
  fetch?: typeof fetch
  /** A WebSocket constructor for connect() (default: the global one). */
  WebSocket?: typeof WebSocket
  /** Extra headers on every HTTP request. */
  headers?: Record<string, string>
}
export interface SqlConfig extends SqlOptions {
  /** The project URL, https://<ref>.stitchdb.com (or your custom domain). */
  url: string
  /** A SQL key, sdb_sql_... */
  key: string
}
export interface QueryOptions {
  /** Rows as arrays of values instead of objects (column order as in `fields`). */
  arrayMode?: boolean
  /** Resolve to the whole result ({ command, rowCount, fields, rows }) instead of the rows. */
  fullResults?: boolean
}
export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  readOnly?: boolean
  deferrable?: boolean
}

/** An error from the database (code is the Postgres SQLSTATE) or from the SQL endpoint. */
export class SqlError extends Error {
  status: number
  code?: string
  detail?: string
  hint?: string
  position?: string
  /** For a transaction: which statement failed. */
  index?: number
  constructor(message: string, info: Record<string, unknown> = {}, status = 0) {
    super(message)
    this.name = 'SqlError'
    this.status = status
    for (const k of ['code', 'detail', 'hint', 'position', 'where', 'schema', 'table', 'column', 'constraint', 'severity', 'index']) {
      if (info[k] !== undefined) (this as Record<string, unknown>)[k] = info[k]
    }
  }
}

const RAW = Symbol('sql.raw')
interface Raw { [RAW]: string }
const isRaw = (v: unknown): v is Raw => !!v && typeof v === 'object' && RAW in (v as object)

/** A query built with the sql`` tag. It runs when awaited, or as part of sql.transaction([...]). */
export class SqlQuery<R = Record<string, unknown>> implements PromiseLike<R[]> {
  readonly query: string
  readonly params: unknown[]
  /** @internal */ readonly _run: ((q: SqlQuery<R>) => Promise<R[]>) | null
  /** @internal */ readonly _opts: QueryOptions
  constructor(query: string, params: unknown[], run: ((q: SqlQuery<R>) => Promise<R[]>) | null, opts: QueryOptions = {}) {
    this.query = query; this.params = params; this._run = run; this._opts = opts
  }
  then<A = R[], B = never>(ok?: ((v: R[]) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    if (!this._run) return Promise.reject(new SqlError('This query is a fragment; use it inside another sql`` query')).then(ok, bad)
    return this._run(this).then(ok, bad)
  }
  catch<B = never>(bad?: ((e: unknown) => B | PromiseLike<B>) | null) { return this.then(undefined, bad) }
}

function encode(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return '\\x' + Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')
  if (Array.isArray(v)) return v.map(encode)
  return v
}

/** Build the text and parameters of a tagged query; nested sql`` fragments and sql.identifier() are inlined. */
function compose(strings: TemplateStringsArray | readonly string[], values: unknown[], params: unknown[] = []): string {
  let text = strings[0]
  values.forEach((v, i) => {
    if (isRaw(v)) text += v[RAW]
    else if (v instanceof SqlQuery) {
      const base = params.length
      text += v.query.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + base}`)
      params.push(...v.params)
    } else { params.push(encode(v)); text += `$${params.length}` }
    text += strings[i + 1]
  })
  return text
}

function parseConnection(conn: string | SqlConfig, options: SqlOptions = {}): SqlConfig {
  if (typeof conn !== 'string') {
    if (!conn?.url || !conn?.key) throw new SqlError('createSql: pass the connection URL from Studio, or { url, key }')
    return { ...options, ...conn }
  }
  let u: URL
  try { u = new URL(conn) } catch { throw new SqlError('createSql: the connection URL looks like https://sdb_sql_...@<ref>.stitchdb.com') }
  const key = decodeURIComponent(u.username || u.password)
  if (!key) throw new SqlError('createSql: the connection URL has no SQL key (https://sdb_sql_...@<ref>.stitchdb.com)')
  return { ...options, url: `${u.protocol}//${u.host}`, key }
}

export interface Sql {
  <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery<R>
  /** Run one statement with $1, $2, ... parameters. */
  query<R = Record<string, unknown>>(text: string, params?: unknown[], options?: QueryOptions & { fullResults?: false }): Promise<R[]>
  query<R = Record<string, unknown>>(text: string, params: unknown[] | undefined, options: QueryOptions & { fullResults: true }): Promise<SqlResult<R>>
  /** Run the statements in one transaction (one HTTP request); resolves to each statement's rows. */
  transaction(queries: SqlQuery<any>[], options?: TransactionOptions & QueryOptions): Promise<any[]>
  /** Open a WebSocket session (interactive transactions, lower latency for many small queries). */
  connect(): Promise<SqlSession>
  /** A quoted identifier (table or column name) to put into a sql`` query. */
  identifier(name: string | string[]): Raw
  /** SQL text put into the query as is. Never pass user input. */
  unsafe(text: string): Raw
}

const ident = (name: string | string[]): Raw => ({ [RAW]: (Array.isArray(name) ? name : [name]).map((n) => '"' + String(n).replace(/"/g, '""') + '"').join('.') })

/** Create a SQL client from the connection URL (https://sdb_sql_...@<ref>.stitchdb.com) or { url, key }. */
export function createSql(connection: string | SqlConfig, options: SqlOptions = {}): Sql {
  const cfg = parseConnection(connection, options)
  const base = cfg.url.replace(/\/+$/, '')
  const doFetch = cfg.fetch || globalThis.fetch
  async function post(body: unknown) {
    const res = await doFetch(`${base}/sql/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}`, ...(cfg.headers || {}) },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: any
    try { json = text ? JSON.parse(text) : {} } catch { throw new SqlError(`SQL endpoint answered ${res.status}: ${text.slice(0, 200)}`, {}, res.status) }
    if (!res.ok) throw new SqlError(json.message || `SQL endpoint answered ${res.status}`, json, res.status)
    return json
  }
  const runOne = (q: SqlQuery<any>) => post({ query: q.query, params: q.params, arrayMode: q._opts.arrayMode })
    .then((r: SqlResult) => (q._opts.fullResults ? r : r.rows) as any)
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const params: unknown[] = []
    const text = compose(strings, values, params)
    return new SqlQuery(text, params, runOne)
  }) as Sql
  sql.query = ((text: string, params: unknown[] = [], opts: QueryOptions = {}) =>
    runOne(new SqlQuery(text, params.map(encode), runOne, opts))) as Sql['query']
  sql.transaction = async (queries, opts = {}) => {
    const r = await post({
      transaction: queries.map((q) => ({ query: q.query, params: q.params, arrayMode: q._opts.arrayMode ?? opts.arrayMode })),
      isolation: opts.isolation, readOnly: opts.readOnly, deferrable: opts.deferrable,
    })
    return (r.results as SqlResult[]).map((x, i) => (queries[i]._opts.fullResults ?? opts.fullResults ? x : x.rows))
  }
  sql.connect = () => SqlSession.open(base, cfg)
  sql.identifier = ident
  sql.unsafe = (text: string) => ({ [RAW]: String(text) })
  return sql
}

type Pending = { ok: (v: any) => void; bad: (e: unknown) => void }

/** A WebSocket session. Statements run in the order they are sent; a transaction holds one database connection. */
export class SqlSession {
  /** @internal */ ws: WebSocket
  /** @internal */ pending = new Map<number, Pending>()
  /** @internal */ next = 1
  /** @internal */ closed: SqlError | null = null
  /** Called with server notices (e.g. a transaction rolled back after being idle for 30 s). */
  onnotice: ((message: string) => void) | null = null

  /** @internal */
  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev: MessageEvent) => {
      let m: any
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) } catch { return }
      if (m.type === 'notice') { this.onnotice?.(m.message); return }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.bad(new SqlError(m.error.message || 'Query failed', m.error, 400)); else p.ok(m.result ?? m)
    })
    ws.addEventListener('close', (ev: CloseEvent) => {
      this.closed = new SqlError(`The SQL session closed${ev.reason ? `: ${ev.reason}` : ''}`, {}, ev.code)
      for (const p of this.pending.values()) p.bad(this.closed)
      this.pending.clear()
    })
  }

  /** @internal */
  static async open(base: string, cfg: SqlConfig): Promise<SqlSession> {
    const WS = cfg.WebSocket || globalThis.WebSocket
    if (!WS) throw new SqlError('This runtime has no WebSocket; pass { WebSocket } to createSql')
    const ws = new WS(base.replace(/^http/, 'ws') + '/sql/v1/ws')
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok(), { once: true })
      ws.addEventListener('error', () => bad(new SqlError('Could not open the SQL session')), { once: true })
    })
    const s = new SqlSession(ws)
    await s.send({ type: 'auth', key: cfg.key })
    return s
  }

  /** @internal */
  send(msg: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise((ok, bad) => { this.pending.set(id, { ok, bad }); this.ws.send(JSON.stringify({ id, ...msg })) })
  }

  /** @internal */
  private run = (q: SqlQuery<any>) => this.send({ type: 'query', query: q.query, params: q.params, arrayMode: q._opts.arrayMode })
    .then((r: SqlResult) => (q._opts.fullResults ? r : r.rows) as any)

  /** sql`` for this session. */
  sql = <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery<R> => {
    const params: unknown[] = []
    return new SqlQuery<R>(compose(strings, values, params), params, this.run)
  }

  /** Run one statement with $1, $2, ... parameters. */
  query<R = Record<string, unknown>>(text: string, params: unknown[] = [], opts: QueryOptions = {}): Promise<any> {
    return this.run(new SqlQuery<R>(text, params.map(encode), this.run, opts))
  }

  begin(opts: TransactionOptions = {}) { return this.send({ type: 'begin', ...opts }).then(() => undefined) }
  commit() { return this.send({ type: 'commit' }).then(() => undefined) }
  rollback() { return this.send({ type: 'rollback' }).then(() => undefined) }

  /** Run fn in a transaction: committed when it returns, rolled back when it throws. */
  async transaction<T>(fn: (tx: SqlSession['sql'] & { query: SqlSession['query'] }) => Promise<T>, opts: TransactionOptions = {}): Promise<T> {
    await this.begin(opts)
    const tx = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => this.sql(s, ...v), { query: this.query.bind(this) })
    try {
      const out = await fn(tx as any)
      await this.commit()
      return out
    } catch (e) {
      if (!this.closed) await this.rollback().catch(() => {})
      throw e
    }
  }

  close() { if (!this.closed) this.ws.close(1000) }
}
