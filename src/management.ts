/**
 * Management API client: create, configure and operate StitchDB projects and organizations from code
 * (`https://stitchdb.com/platform/v1`). The same API the `stitchdb` CLI and the dashboard use.
 *
 * ```ts
 * import { createManagementClient } from 'stitchdb-js/management'
 *
 * const mgmt = createManagementClient({ accessToken: process.env.STITCHDB_ACCESS_TOKEN })
 * const { data: project, error } = await mgmt.projects.create({ name: 'shop', region: 'eu-central' })
 * if (error) throw error
 * const { data: res } = await mgmt.database.query(project.ref, 'select count(*) from orders')
 * ```
 *
 * Credentials: a personal access token (`sdb_pat_…`), an OAuth access token, an organization token (`sdb_org_…`) or a
 * short-lived project token (`sdb_prj_…`). Agent keys (`sdb_agt_…`) use {@link createAgentClient}. Keep every one of
 * them on a server: they act on your projects.
 *
 * Every method resolves to `{ data, error }` and never throws: `error` is a {@link ManagementError} with the HTTP
 * status, the server's message, and its `code` / `hint` when it sent them. 429, 502 and 503 answers are retried
 * (honouring `Retry-After`).
 * @module management
 */
import { version } from './lib/version'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** An error from the Management API (status 0: the request did not reach the server). */
export class ManagementError extends Error {
  /** HTTP status (0 for a network error). */
  status: number
  /** Machine-readable code when the server sent one (for example `plan_limit`, or a Postgres SQLSTATE for SQL errors). */
  code?: string
  /** What to do about it, when the server (or the client) knows. */
  hint?: string
  /** Postgres error detail and position for SQL errors. */
  detail?: string
  position?: number
  /** The whole error body as the server sent it. */
  body: unknown
  constructor(message: string, status: number, body: unknown = null, hint?: string) {
    super(message)
    this.name = 'ManagementError'
    this.status = status
    this.body = body
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (typeof b.code === 'string') this.code = b.code
    if (typeof b.detail === 'string') this.detail = b.detail
    if (typeof b.position === 'number') this.position = b.position
    this.hint = typeof b.hint === 'string' ? b.hint : hint
  }
}

/** What every method resolves to. `nextCursor` is set when the server returned an `X-Next-Cursor` header. */
export type MgmtResult<T> =
  | { data: T; error: null; status: number; nextCursor: string | null }
  | { data: null; error: ManagementError; status: number; nextCursor: null }

export interface ManagementClientOptions {
  /** A personal access token (sdb_pat_…), OAuth access token, organization token (sdb_org_…) or project token (sdb_prj_…). */
  accessToken: string
  /** Default `https://stitchdb.com`. */
  apiUrl?: string
  /** A fetch to use (default: the global one). */
  fetch?: FetchLike
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** How many times to retry 429 / 502 / 503 answers (default 3). */
  retries?: number
}
export interface AgentClientOptions extends Omit<ManagementClientOptions, 'accessToken'> {
  /** An agent key, sdb_agt_… */
  agentKey: string
}

export type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>
export interface RequestOptions {
  query?: Query
  /** JSON body (sent with Content-Type: application/json). */
  body?: unknown
  headers?: Record<string, string>
}

type Json = Record<string, unknown>

// ---------- shapes ----------
/** A project in lists. */
export interface ProjectSummary {
  ref: string; name: string; status: string; region: string; created_at: string; api_url: string; role?: string
  org_id: string; parent_ref: string | null; git_branch: string | null; labels: Record<string, string>; expires_at: string | null
}
/** One project (keys, connection details and template state included where your credential may see them). */
export type Project = ProjectSummary & Json
export interface ProjectListOptions {
  organization_id?: string
  /** `key:value` label filters (all must match). */
  label?: string | string[]
  status?: string
  include_branches?: boolean
  /** Page size (1–1000); without it every project is returned. */
  limit?: number
  /** The `nextCursor` of the previous page. */
  cursor?: string
}
export interface ProjectTemplate {
  from_project?: string
  migrations?: { version: string; name?: string; sql: string }[]
  sql?: string
  seed?: string
  data?: 'none' | 'masked' | 'full'
  tables?: string[]
  include_auth?: boolean
}
export interface CreateProjectInput {
  name: string
  region?: string
  organization_id?: string
  labels?: Record<string, string>
  /** Per-project caps, lower than the plan's. */
  limits?: Record<string, number | null>
  ttl_seconds?: number
  expires_at?: string
  template?: ProjectTemplate
}
export interface UpdateProjectInput {
  name?: string
  /** A null value removes that label. */
  labels?: Record<string, string | null>
  expires_at?: string | null
  ttl_seconds?: number | null
}
export interface ApiKey { name: 'anon' | 'service_role' | string; api_key: string }
export interface QueryInput {
  query: string
  /** Run in a read-only transaction. */
  read_only?: boolean
  /** Statement timeout, 1000–120000 ms (default 30000). */
  timeout_ms?: number
}
export interface StatementResult { command: string; row_count: number | null; columns: string[]; rows: Json[]; truncated?: boolean }
/** SQL result: the rows of the last statement, and every statement's result. Agent keys may get `status: 'pending_approval'` instead. */
export interface QueryResult { rows: Json[]; results: StatementResult[]; [k: string]: unknown }
export interface Migration { version: string; name?: string; sql: string }
export type TypesLanguage = 'typescript' | 'dart' | 'swift' | 'kotlin'
export interface FunctionFile {
  name: string
  /** Text (sent as UTF-8) or bytes (sent as base64). */
  content: string | Uint8Array
}
export interface DeployFunctionInput {
  slug: string
  name?: string
  verify_jwt?: boolean
  entrypoint?: string
  import_map?: string
  files: FunctionFile[]
}
export interface FunctionLogOptions { limit?: number; level?: string; since?: string; before?: string; search?: string }
export interface LogSearchOptions {
  source?: 'api' | 'auth' | 'rest' | 'postgres' | 'functions' | string
  q?: string; level?: string; status?: string | number; since?: string; until?: string; limit?: number; cursor?: string
}
export interface ProjectWebhookInput {
  name?: string; url?: string; enabled?: boolean; events?: string[]; tables?: string[]; headers?: Record<string, string>
  insert?: boolean; update?: boolean; delete?: boolean; tenants?: unknown
}
export interface LogDrainInput {
  name?: string; kind?: string; enabled?: boolean; config?: Json; sources?: string[]; min_level?: string; gzip?: boolean; request?: Json
}
export interface OrgWebhookInput { url?: string; events?: string[]; description?: string; usage_thresholds?: number[]; enabled?: boolean }
export interface OrgTokenInput {
  name?: string; scopes?: string[]; project_refs?: string[]; ip_allowlist?: string[]; expires_in_days?: number; rate_per_sec?: number
}
export interface ProjectTokenInput { name?: string; scopes?: string[]; expires_in?: number; ip_allowlist?: string[] }
export type MemberRole = 'admin' | 'developer' | 'read_only'
export interface AgentKeyInput { name?: string; preset?: string; policy?: Json; ip_allowlist?: string[]; [k: string]: unknown }

export interface CloudflareLinkInput {
  /** A Cloudflare API token that can edit Workers / Pages (and Hyperdrive). */
  token: string
  account_id: string
  kind: 'worker' | 'pages'
  /** The Worker script or Pages project name. */
  name: string
  targets?: ('production' | 'preview')[]
  prefix?: string
  service_key?: boolean
  database_url?: boolean
  hyperdrive?: boolean
}
export interface TableRestoreInput {
  schema?: string
  table: string
  /** `copy` restores into a new table; `replace` and `merge` change the table itself. */
  mode: 'copy' | 'replace' | 'merge'
  /** A SQL condition to restore only some rows. */
  where?: string
  target_time: string
}
export interface ComputeInput { size_key: string; idempotency_key?: string; [k: string]: unknown }
export interface AutoReplicaSettings { enabled?: boolean; up_pct?: number; up_minutes?: number; down_pct?: number; down_minutes?: number; max_replicas?: number }
export interface BudgetInput {
  /** A limit per resource (null removes one). */
  limits?: Record<string, number | null>
  /** Alert at these percentages of each limit (default 50, 80, 100). */
  thresholds?: number[]
  /** Resources that stop at their limit. */
  hard_stop?: string[]
  telegram?: { chat_id: string; bot_token?: string } | null
  [k: string]: unknown
}
export interface FlagInput {
  key?: string
  type?: 'boolean' | 'string' | 'number' | 'json'
  name?: string; description?: string; enabled?: boolean; archived?: boolean; client?: boolean
  variations?: unknown[]; rules?: unknown[]; fallthrough?: unknown; off_variation?: number
  [k: string]: unknown
}
export interface SegmentInput { key?: string; name?: string; description?: string; included?: string[]; excluded?: string[]; conditions?: unknown[]; [k: string]: unknown }
export interface InboundEndpointInput {
  slug?: string; name?: string; provider?: string; secret?: string; opts?: Json
  /** The Edge Function that handles the events. */
  function?: string | null
  enabled?: boolean; keep_days?: number | null; rotate?: boolean
  [k: string]: unknown
}
export interface IncidentInput {
  title?: string
  impact?: 'minor' | 'major' | 'critical' | 'maintenance' | string
  status?: string
  message?: string
  components?: string[]
  /** Scheduled maintenance window. */
  starts_at?: string; ends_at?: string
  [k: string]: unknown
}
export interface CronJobInput {
  /** The job name (`name` is accepted too). */
  jobname?: string
  name?: string
  /** A cron expression (`0 3 * * *`) or a pg_cron interval (`30 seconds`). */
  schedule?: string
  /** The SQL to run. */
  command?: string
  active?: boolean
}
export interface PushConfigInput {
  ios?: { p8?: string; key_id: string; team_id: string; bundle_id: string; production?: boolean } | null
  android?: { service_account: string | Json } | null
}
export interface LinkInput { code?: string; data?: Json; [k: string]: unknown }
export interface MonitorInput {
  kind?: 'ping' | 'cron' | 'job'
  name?: string
  /** pg_cron job name (kind `cron`). */
  target?: string
  /** A cron expression (with `tz`), or `period_s` for a fixed interval. */
  schedule?: string; tz?: string; period_s?: number; grace_s?: number; max_runtime_s?: number; paused?: boolean
  [k: string]: unknown
}
export interface SsoProviderInput { metadata_url?: string; metadata_xml?: string; domains?: string[]; attribute_mapping?: Json; [k: string]: unknown }
export interface TrackTableInput { schema?: string; table: string; enabled: boolean }
export interface SharedViewInput {
  name?: string; schema?: string; table?: string; columns?: string[]; editable?: string[]; filters?: unknown[]
  can_insert?: boolean; can_delete?: boolean; disabled?: boolean
  [k: string]: unknown
}

// ---------- helpers ----------
const enc = encodeURIComponent
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function toBase64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)))
  return btoa(s)
}
function retryDelay(res: Response, attempt: number): number {
  const h = res.headers.get('retry-after')
  if (h != null && h.trim() !== '') {
    const n = Number(h)
    if (Number.isFinite(n)) return Math.min(60000, Math.max(0, n * 1000))
    const t = Date.parse(h)
    if (!Number.isNaN(t)) return Math.min(60000, Math.max(0, t - Date.now()))
  }
  return 1000 * (attempt + 1)
}
function hintFor(status: number, msg: string): string | undefined {
  if (status === 401) return 'The access token is invalid or expired.'
  if (status === 404 && /project/i.test(msg)) return 'Check the project reference, and that your account (or token) can access it.'
  if (status === 403 && /read-only/i.test(msg)) return 'Use a read-write access token.'
  return undefined
}

/** The HTTP layer shared by the management and agent clients. */
class Transport {
  private base: string
  private fetchImpl: FetchLike
  constructor(private token: string, private opts: Omit<ManagementClientOptions, 'accessToken'>) {
    if (!token) throw new Error('An access token is required')
    this.base = (opts.apiUrl || 'https://stitchdb.com').replace(/\/+$/, '') + '/platform/v1'
    const f = opts.fetch || (typeof fetch === 'function' ? fetch : undefined)
    if (!f) throw new Error('No fetch available: pass options.fetch')
    this.fetchImpl = opts.fetch ? opts.fetch : (input, init) => (f as FetchLike)(input, init)
  }

  url(path: string, query?: Query): string {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue
      if (Array.isArray(v)) for (const x of v) q.append(k, String(x))
      else q.set(k, String(v))
    }
    const s = q.toString()
    return this.base + (path.startsWith('/') ? path : '/' + path) + (s ? '?' + s : '')
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<MgmtResult<T>> {
    const url = this.url(path, options.query)
    const headers: Record<string, string> = {
      Accept: 'application/json', 'X-Client-Info': `stitchdb-js/${version}`, ...(this.opts.headers || {}), ...(options.headers || {}),
      Authorization: `Bearer ${this.token}`,
    }
    const hasBody = options.body !== undefined
    if (hasBody) headers['Content-Type'] = 'application/json'
    const init: RequestInit = { method, headers, ...(hasBody ? { body: JSON.stringify(options.body) } : {}) }
    const retries = this.opts.retries ?? 3
    const idempotent = method === 'GET' || method === 'HEAD'
    let res: Response
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetchImpl(url, init)
      } catch (e: any) {
        // Network errors: only safe (read) requests are sent again; a write may have reached the server.
        if (idempotent && attempt < 2) { await sleep(800 * (attempt + 1)); continue }
        return { data: null, error: new ManagementError(`Could not reach the Management API: ${e?.cause?.code || e?.message || e}`, 0), status: 0, nextCursor: null }
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < retries) {
        await sleep(retryDelay(res, attempt))
        continue
      }
      break
    }
    const text = await res.text().catch(() => '')
    const isJson = /json/i.test(res.headers.get('content-type') || '')
    let data: unknown = text
    if (isJson || (!res.ok && text)) { try { data = text ? JSON.parse(text) : null } catch { data = isJson ? null : text } }
    else if (!text) data = null
    if (!res.ok) {
      const b = (data && typeof data === 'object' ? data : {}) as Json
      const msg = String(b.error || b.message || (typeof data === 'string' && data ? data.slice(0, 300) : '') || `Request failed (${res.status})`)
      return { data: null, error: new ManagementError(msg, res.status, data, hintFor(res.status, msg)), status: res.status, nextCursor: null }
    }
    return { data: data as T, error: null, status: res.status, nextCursor: res.headers.get('x-next-cursor') }
  }
}

// ---------- management client ----------
/**
 * The Management API client. Methods are grouped by resource (`mgmt.projects`, `mgmt.database`, …); `mgmt.request()`
 * calls any `/platform/v1` endpoint directly.
 */
export class ManagementClient {
  private t: Transport
  constructor(options: ManagementClientOptions) {
    this.t = new Transport(options?.accessToken, options || ({} as ManagementClientOptions))
  }

  /** Any endpoint: `mgmt.request('GET', '/projects/<ref>/usage', { query: { from: '2026-10-01' } })`. Paths are relative to /platform/v1. */
  request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<MgmtResult<T>> {
    return this.t.request<T>(method, path, options)
  }
  private r<T>(method: string, path: string, options?: RequestOptions) { return this.t.request<T>(method, path, options) }
  private p(ref: string, rest = '') { return `/projects/${enc(ref)}${rest}` }

  /** The OpenAPI 3.1 description of this API. `GET /openapi.json` */
  openapi(): Promise<MgmtResult<Json>> { return this.r('GET', '/openapi.json') }

  /** Projects: list, provision, change, pause, restart, keys, limits, usage. */
  readonly projects = {
    /** Projects you (or the token) can reach, branches included unless `include_branches: false`. `GET /projects` */
    list: (o: ProjectListOptions = {}) => this.r<ProjectSummary[]>('GET', '/projects', { query: { ...o, label: o.label as string | string[] | undefined } as Query }),
    /** One project. `GET /projects/:ref` */
    get: (ref: string) => this.r<Project>('GET', this.p(ref)),
    /** Create a project; it comes back at once with status `provisioning`. `POST /projects` (Idempotency-Key supported) */
    create: (input: CreateProjectInput, o: { idempotencyKey?: string } = {}) =>
      this.r<Project>('POST', '/projects', { body: input, headers: o.idempotencyKey ? { 'Idempotency-Key': o.idempotencyKey } : undefined }),
    /** Rename, change labels or the expiry. `PATCH /projects/:ref` */
    update: (ref: string, patch: UpdateProjectInput) => this.r<Project>('PATCH', this.p(ref), { body: patch }),
    /** Delete a project with its database, files and functions (not reversible). `DELETE /projects/:ref` */
    delete: (ref: string) => this.r<{ deleted: string }>('DELETE', this.p(ref)),
    /** Pause: services stop, data is kept. `POST /projects/:ref/pause` */
    pause: (ref: string) => this.r<{ paused: boolean; already?: boolean }>('POST', this.p(ref, '/pause')),
    /** Restore a paused project. `POST /projects/:ref/restore` */
    restore: (ref: string) => this.r<Json>('POST', this.p(ref, '/restore')),
    /** The anon key, and the service_role key for admin-level read-write credentials. `GET /projects/:ref/api-keys` */
    apiKeys: (ref: string) => this.r<ApiKey[]>('GET', this.p(ref, '/api-keys')),
    /** New anon and service_role keys; the old ones keep working for `grace_seconds`. `POST /projects/:ref/api-keys/rotate` */
    rotateKeys: (ref: string, o: { grace_seconds?: number } = {}) => this.r<Json>('POST', this.p(ref, '/api-keys/rotate'), { body: o }),
    /** Plan limits, per-project caps and the effective limits. `GET /projects/:ref/limits` */
    limits: (ref: string) => this.r<{ plan: string; plan_limits: Json; caps: Json; effective: Json; cappable: string[] }>('GET', this.p(ref, '/limits')),
    /** Set per-project caps (lower than the plan; null removes one). `PATCH /projects/:ref/limits` */
    updateLimits: (ref: string, caps: Record<string, number | null>) => this.r<{ caps: Json; effective: Json }>('PATCH', this.p(ref, '/limits'), { body: caps }),
    /** Daily usage. `GET /projects/:ref/usage?from&to` */
    usage: (ref: string, o: { from?: string; to?: string } = {}) => this.r<Json>('GET', this.p(ref, '/usage'), { query: o }),
    /** Restart the project's Auth and REST services. `POST /projects/:ref/restart` */
    restart: (ref: string) => this.r<Json>('POST', this.p(ref, '/restart')),
    /** Time series for the project charts. `GET /projects/:ref/metrics?range=1h|24h|7d|30d|13mo` */
    metrics: (ref: string, o: { range?: '1h' | '24h' | '7d' | '30d' | '13mo' } = {}) => this.r<Json>('GET', this.p(ref, '/metrics'), { query: o }),
  }

  /** SQL, schema dumps, generated types, advisors, statement statistics. */
  readonly database = {
    /** Run SQL. `POST /projects/:ref/database/query` */
    query: (ref: string, input: string | QueryInput) => this.r<QueryResult>('POST', this.p(ref, '/database/query'), { body: typeof input === 'string' ? { query: input } : input }),
    /** What each statement would lock and for how long, without running it. `POST /projects/:ref/database/query/check` */
    checkQuery: (ref: string, query: string) => this.r<Json>('POST', this.p(ref, '/database/query/check'), { body: { query } }),
    /** A SQL dump (text): the schema, or the data with `dataOnly` (admins). `GET /projects/:ref/database/dump` */
    dump: (ref: string, o: { schemas?: string[]; dataOnly?: boolean } = {}) =>
      this.r<string>('GET', this.p(ref, '/database/dump'), { query: { schemas: o.schemas?.join(','), data_only: o.dataOnly ? '1' : undefined }, headers: { Accept: 'application/sql, text/plain, */*' } }),
    /** Generated models. `GET /projects/:ref/types/typescript|dart|swift|kotlin` */
    types: (ref: string, lang: TypesLanguage = 'typescript', o: { schemas?: string[]; package?: string } = {}) =>
      this.r<{ types: string }>('GET', this.p(ref, `/types/${lang}`), { query: { schemas: o.schemas?.join(','), package: o.package } }),
    /** Security, performance and health findings. `GET /projects/:ref/advisors[/security|performance|health]` */
    advisors: (ref: string, type?: 'security' | 'performance' | 'health') => this.r<Json>('GET', this.p(ref, type ? `/advisors/${type}` : '/advisors')),
    /** Slowest and most frequent statements. `GET /projects/:ref/database/query-performance?sort&limit` */
    queryPerformance: (ref: string, o: { sort?: 'total' | 'mean' | 'calls' | 'rows' | 'io'; limit?: number } = {}) =>
      this.r<Json>('GET', this.p(ref, '/database/query-performance'), { query: o }),
    /** Reset the statement statistics. `DELETE /projects/:ref/database/query-performance` */
    resetQueryPerformance: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/database/query-performance')),
  }

  /** Versioned schema migrations. */
  readonly migrations = {
    /** Migration history. `GET /projects/:ref/migrations` */
    list: (ref: string, o: { includeSql?: boolean } = {}) => this.r<Json[]>('GET', this.p(ref, '/migrations'), { query: { include_sql: o.includeSql ? '1' : undefined } }),
    /** Apply the ones not applied yet (in order). `dryRun` reports what would run with lock warnings; `enforce: 'block'` refuses new critical exposures. `POST /projects/:ref/migrations` */
    apply: (ref: string, migrations: Migration[], o: { dryRun?: boolean; enforce?: 'block' } = {}) =>
      this.r<Json>('POST', this.p(ref, '/migrations'), { body: { migrations, ...(o.dryRun ? { dry_run: true } : {}), ...(o.enforce ? { enforce: o.enforce } : {}) } }),
    /** What each statement would lock, without running anything. `POST /projects/:ref/migrations/check` */
    check: (ref: string, migrations: Migration[]) => this.r<Json>('POST', this.p(ref, '/migrations/check'), { body: { migrations } }),
    /** Mark a version applied or reverted in the history without running it. `POST /projects/:ref/migrations/repair` */
    repair: (ref: string, input: { version: string; status: 'applied' | 'reverted'; name?: string; sql?: string }) =>
      this.r<Json>('POST', this.p(ref, '/migrations/repair'), { body: input }),
  }

  /** Preview branches and masked branch data. */
  readonly branches = {
    /** Branches of a project. `GET /projects/:ref/branches` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/branches')),
    /** Create (or return the existing) branch. `POST /projects/:ref/branches` */
    create: (ref: string, input: { name?: string; git_branch?: string; data?: string; with_data?: boolean; seed?: string; restore?: unknown; allow_main?: boolean; [k: string]: unknown }) =>
      this.r<Json>('POST', this.p(ref, '/branches'), { body: input }),
    /** One branch, by its own ref. `GET /branches/:ref` */
    get: (branchRef: string) => this.r<Json>('GET', `/branches/${enc(branchRef)}`),
    /** Delete a branch. `DELETE /branches/:ref` */
    delete: (branchRef: string) => this.r<Json>('DELETE', `/branches/${enc(branchRef)}`),
    /** Apply the branch's new migrations to its parent. `POST /branches/:ref/merge` */
    merge: (branchRef: string, o: { dry_run?: boolean; delete?: boolean } = {}) => this.r<Json>('POST', `/branches/${enc(branchRef)}/merge`, { body: o }),
    /** Masking rules per column. `GET /projects/:ref/branches/masking` */
    masking: (ref: string) => this.r<Json>('GET', this.p(ref, '/branches/masking')),
    /** Set masking rules. `PUT /projects/:ref/branches/masking` */
    setMasking: (ref: string, rules: Json) => this.r<Json>('PUT', this.p(ref, '/branches/masking'), { body: rules }),
    /** What a masked copy would contain. `GET /projects/:ref/branches/masking/preview` */
    maskingPreview: (ref: string) => this.r<Json>('GET', this.p(ref, '/branches/masking/preview')),
  }

  /** Edge Functions. */
  readonly functions = {
    /** `GET /projects/:ref/functions` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/functions')),
    /** `GET /projects/:ref/functions/:slug` */
    get: (ref: string, slug: string) => this.r<Json>('GET', this.p(ref, `/functions/${enc(slug)}`)),
    /** Deploy a new version from source files (text or bytes). `POST /projects/:ref/functions` */
    deploy: (ref: string, input: DeployFunctionInput) => this.r<Json>('POST', this.p(ref, '/functions'), {
      body: { ...input, files: input.files.map((f) => (typeof f.content === 'string' ? { name: f.name, content: f.content, encoding: 'utf8' } : { name: f.name, content: toBase64(f.content) })) },
    }),
    /** Change the name or JWT check, or switch to another `version`. `PATCH /projects/:ref/functions/:slug` */
    update: (ref: string, slug: string, patch: { name?: string; verify_jwt?: boolean; version?: number }) => this.r<Json>('PATCH', this.p(ref, `/functions/${enc(slug)}`), { body: patch }),
    /** `DELETE /projects/:ref/functions/:slug` */
    delete: (ref: string, slug: string) => this.r<Json>('DELETE', this.p(ref, `/functions/${enc(slug)}`)),
    /** Source files of the current (or a given) version. `GET /projects/:ref/functions/:slug/body` */
    body: (ref: string, slug: string, o: { version?: number } = {}) => this.r<Json>('GET', this.p(ref, `/functions/${enc(slug)}/body`), { query: o }),
    /** `GET /projects/:ref/functions/:slug/versions` */
    versions: (ref: string, slug: string) => this.r<Json[]>('GET', this.p(ref, `/functions/${enc(slug)}/versions`)),
    /** Logs of one function, or of every function without a slug. `GET /projects/:ref/functions[/:slug]/logs` */
    logs: (ref: string, slug?: string | null, o: FunctionLogOptions = {}) =>
      this.r<Json>('GET', this.p(ref, slug ? `/functions/${enc(slug)}/logs` : '/functions/logs'), { query: o as Query }),
    /** Invocations, errors and latency. `GET /projects/:ref/functions/:slug/stats?hours` */
    stats: (ref: string, slug: string, o: { hours?: number } = {}) => this.r<Json>('GET', this.p(ref, `/functions/${enc(slug)}/stats`), { query: o }),
    /** This month's invocations and the plan limits. `GET /projects/:ref/functions/usage` */
    usage: (ref: string) => this.r<Json>('GET', this.p(ref, '/functions/usage')),
  }

  /** Function secrets (values are write-only). */
  readonly secrets = {
    /** Names and sha256 digests. `GET /projects/:ref/secrets` */
    list: (ref: string) => this.r<{ name: string; digest?: string; [k: string]: unknown }[]>('GET', this.p(ref, '/secrets')),
    /** Set secrets: `{ NAME: 'value' }` or `[{ name, value }]`. `POST /projects/:ref/secrets` */
    set: (ref: string, secrets: Record<string, string> | { name: string; value: string }[]) => this.r<Json>('POST', this.p(ref, '/secrets'), { body: secrets }),
    /** `DELETE /projects/:ref/secrets` */
    delete: (ref: string, names: string[]) => this.r<Json>('DELETE', this.p(ref, '/secrets'), { body: { names } }),
  }

  /** Database and Auth event webhooks of a project. */
  readonly webhooks = {
    /** `GET /projects/:ref/webhooks` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/webhooks')),
    /** `POST /projects/:ref/webhooks` */
    create: (ref: string, input: ProjectWebhookInput) => this.r<Json>('POST', this.p(ref, '/webhooks'), { body: input }),
    /** `GET /projects/:ref/webhooks/:id` */
    get: (ref: string, id: string) => this.r<Json>('GET', this.p(ref, `/webhooks/${enc(id)}`)),
    /** `PATCH /projects/:ref/webhooks/:id` */
    update: (ref: string, id: string, patch: ProjectWebhookInput) => this.r<Json>('PATCH', this.p(ref, `/webhooks/${enc(id)}`), { body: patch }),
    /** `DELETE /projects/:ref/webhooks/:id` */
    delete: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/webhooks/${enc(id)}`)),
    /** The signing secret. `GET /projects/:ref/webhooks/:id/secret` */
    secret: (ref: string, id: string) => this.r<Json>('GET', this.p(ref, `/webhooks/${enc(id)}/secret`)),
    /** A new signing secret. `POST /projects/:ref/webhooks/:id/rotate-secret` */
    rotateSecret: (ref: string, id: string) => this.r<Json>('POST', this.p(ref, `/webhooks/${enc(id)}/rotate-secret`)),
    /** Send a test event. `POST /projects/:ref/webhooks/:id/test` */
    test: (ref: string, id: string) => this.r<Json>('POST', this.p(ref, `/webhooks/${enc(id)}/test`)),
    /** Recent deliveries. `GET /projects/:ref/webhooks/:id/deliveries?status&limit&before` */
    deliveries: (ref: string, id: string, o: { status?: 'pending' | 'delivered' | 'dead'; limit?: number; before?: string } = {}) =>
      this.r<Json[]>('GET', this.p(ref, `/webhooks/${enc(id)}/deliveries`), { query: o }),
    /** One delivery with its request and response. `GET /projects/:ref/webhooks/:id/deliveries/:deliveryId` */
    delivery: (ref: string, id: string, deliveryId: string) => this.r<Json>('GET', this.p(ref, `/webhooks/${enc(id)}/deliveries/${enc(deliveryId)}`)),
    /** Deliver again: one delivery, or every one with a status since a time. `POST /projects/:ref/webhooks/:id/replay` */
    replay: (ref: string, id: string, o: { delivery_id?: string; status?: string; since?: string } = {}) => this.r<Json>('POST', this.p(ref, `/webhooks/${enc(id)}/replay`), { body: o }),
  }

  /** Log drains (send project logs to your own service). */
  readonly logDrains = {
    /** `GET /projects/:ref/log-drains` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/log-drains')),
    /** `POST /projects/:ref/log-drains` */
    create: (ref: string, input: LogDrainInput) => this.r<Json>('POST', this.p(ref, '/log-drains'), { body: input }),
    /** `PATCH /projects/:ref/log-drains/:id` */
    update: (ref: string, id: string, patch: LogDrainInput) => this.r<Json>('PATCH', this.p(ref, `/log-drains/${enc(id)}`), { body: patch }),
    /** `DELETE /projects/:ref/log-drains/:id` */
    delete: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/log-drains/${enc(id)}`)),
    /** Send a test line now. `POST /projects/:ref/log-drains/:id/test` */
    test: (ref: string, id: string) => this.r<Json>('POST', this.p(ref, `/log-drains/${enc(id)}/test`)),
  }

  /** Project logs. */
  readonly logs = {
    /** Search logs, newest first; pass the returned `next` as `cursor` for the next page. `GET /projects/:ref/logs` */
    search: (ref: string, o: LogSearchOptions = {}) => this.r<{ lines: Json[]; next: string | null; [k: string]: unknown }>('GET', this.p(ref, '/logs'), { query: o as Query }),
    /** A log query (`SELECT … FROM api …` or a JSON query) over at most 24 hours. `POST /projects/:ref/logs/query` */
    query: (ref: string, query: string | Json, o: { since?: string; until?: string } = {}) => this.r<Json>('POST', this.p(ref, '/logs/query'), { body: { query, ...o } }),
  }

  /** Custom domains. */
  readonly domains = {
    /** The CNAME target, the plan limit and every domain with its status. `GET /projects/:ref/custom-domains` */
    list: (ref: string) => this.r<Json>('GET', this.p(ref, '/custom-domains')),
    /** One domain with the DNS records to add. `GET /projects/:ref/custom-domains/:domain` */
    get: (ref: string, domain: string) => this.r<Json>('GET', this.p(ref, `/custom-domains/${enc(domain)}`)),
    /** Add a domain (checks DNS and requests the certificate). `POST /projects/:ref/custom-domains` */
    add: (ref: string, domain: string) => this.r<Json>('POST', this.p(ref, '/custom-domains'), { body: { domain } }),
    /** Check DNS and the certificate now. `POST /projects/:ref/custom-domains/:domain/check` */
    check: (ref: string, domain: string) => this.r<Json>('POST', this.p(ref, `/custom-domains/${enc(domain)}/check`)),
    /** Use a live domain for Auth or for the status page. `PUT /projects/:ref/custom-domains/:domain` */
    update: (ref: string, domain: string, o: { use_for_auth?: boolean; use_for_status?: boolean }) => this.r<Json>('PUT', this.p(ref, `/custom-domains/${enc(domain)}`), { body: o }),
    /** Stop serving a domain and delete its certificate. `DELETE /projects/:ref/custom-domains/:domain` */
    delete: (ref: string, domain: string) => this.r<Json>('DELETE', this.p(ref, `/custom-domains/${enc(domain)}`)),
  }

  /** Vercel and Cloudflare environment variable sync, and the GitHub App link. */
  readonly integrations = {
    vercel: {
      /** Linked Vercel projects. `GET /projects/:ref/integrations/vercel` */
      list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/integrations/vercel')),
      /** Teams and projects a Vercel token can reach. `POST /projects/:ref/integrations/vercel/browse` */
      browse: (ref: string, o: { token: string; team_id?: string }) => this.r<Json>('POST', this.p(ref, '/integrations/vercel/browse'), { body: o }),
      /** Link a Vercel project and write its environment variables. `POST /projects/:ref/integrations/vercel` */
      link: (ref: string, input: { token: string; vercel_project_id: string; team_id?: string; targets?: ('production' | 'preview' | 'development')[]; prefix?: string; service_key?: boolean; database_url?: boolean }) =>
        this.r<Json>('POST', this.p(ref, '/integrations/vercel'), { body: input }),
      /** Change targets, prefix, variables or token (syncs again). `PATCH /projects/:ref/integrations/vercel/:id` */
      update: (ref: string, id: string, patch: Json) => this.r<Json>('PATCH', this.p(ref, `/integrations/vercel/${enc(id)}`), { body: patch }),
      /** Write the variables again now. `POST /projects/:ref/integrations/vercel/:id/sync` */
      sync: (ref: string, id: string) => this.r<Json>('POST', this.p(ref, `/integrations/vercel/${enc(id)}/sync`)),
      /** Unlink (`removeVariables` also deletes them in Vercel). `DELETE /projects/:ref/integrations/vercel/:id` */
      unlink: (ref: string, id: string, o: { removeVariables?: boolean } = {}) =>
        this.r<Json>('DELETE', this.p(ref, `/integrations/vercel/${enc(id)}`), { query: { remove_variables: o.removeVariables ? 'true' : undefined } }),
    },
    cloudflare: {
      /** Linked Cloudflare Workers and Pages projects. `GET /projects/:ref/integrations/cloudflare` */
      list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/integrations/cloudflare')),
      /** Accounts, Workers and Pages projects a Cloudflare token can reach. `POST /projects/:ref/integrations/cloudflare/browse` */
      browse: (ref: string, o: { token: string; account_id?: string }) => this.r<Json>('POST', this.p(ref, '/integrations/cloudflare/browse'), { body: o }),
      /** Link a Worker or Pages project and write its variables (and a Hyperdrive config). `POST /projects/:ref/integrations/cloudflare` */
      link: (ref: string, input: CloudflareLinkInput) => this.r<Json>('POST', this.p(ref, '/integrations/cloudflare'), { body: input }),
      /** Change targets, prefix, variables or token (syncs again). `PATCH /projects/:ref/integrations/cloudflare/:id` */
      update: (ref: string, id: string, patch: Partial<Omit<CloudflareLinkInput, 'account_id' | 'kind' | 'name'>>) =>
        this.r<Json>('PATCH', this.p(ref, `/integrations/cloudflare/${enc(id)}`), { body: patch }),
      /** Write the variables again now. `POST /projects/:ref/integrations/cloudflare/:id/sync` */
      sync: (ref: string, id: string) => this.r<Json>('POST', this.p(ref, `/integrations/cloudflare/${enc(id)}/sync`)),
      /** Unlink (`removeVariables` also deletes them in Cloudflare). `DELETE /projects/:ref/integrations/cloudflare/:id` */
      unlink: (ref: string, id: string, o: { removeVariables?: boolean } = {}) =>
        this.r<Json>('DELETE', this.p(ref, `/integrations/cloudflare/${enc(id)}`), { query: { remove_variables: o.removeVariables ? 'true' : undefined } }),
    },
    github: {
      /** The linked repository, installations and recent runs. `GET /projects/:ref/integrations/github` */
      get: (ref: string) => this.r<Json>('GET', this.p(ref, '/integrations/github')),
      /** Repositories an installation can reach. `GET /projects/:ref/integrations/github/repositories?installation_id` */
      repositories: (ref: string, installationId: number | string) => this.r<Json>('GET', this.p(ref, '/integrations/github/repositories'), { query: { installation_id: installationId } }),
      /** Link a repository (a preview branch per pull request). `PUT /projects/:ref/integrations/github` */
      link: (ref: string, input: { installation_id: number; repo_id: number; production_branch?: string; dir?: string; deploy_production?: boolean; branch_data?: 'none' | 'masked' }) =>
        this.r<Json>('PUT', this.p(ref, '/integrations/github'), { body: input }),
      /** Unlink the repository (existing branches stay). `DELETE /projects/:ref/integrations/github` */
      unlink: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/integrations/github')),
    },
  }

  /** Organizations: billing, usage, audit log, members, invitations, tokens, connected apps, webhooks. */
  readonly organizations = (() => {
    const o = (org: string, rest = '') => `/organizations/${enc(org)}${rest}`
    return {
      /** Organizations this credential can act in. `GET /organizations` */
      list: () => this.r<{ id: string; name: string; role: string; [k: string]: unknown }[]>('GET', '/organizations'),
      /** Plan, limits and billing state (owner). `GET /organizations/:org/billing` */
      billing: (org: string) => this.r<Json>('GET', o(org, '/billing')),
      /** Usage of every project in a date range (`format: 'csv'` returns text). `GET /organizations/:org/usage` */
      usage: (org: string, q: { from?: string; to?: string; format?: 'json' | 'csv' } = {}) => this.r<Json | string>('GET', o(org, '/usage'), { query: q }),
      /** Audit log, newest first; next page via `nextCursor` → `before`. `GET /organizations/:org/audit-log` */
      auditLog: (org: string, q: { action?: string; actor?: string; project?: string; since?: string; until?: string; before?: string; limit?: number; format?: 'csv' } = {}) =>
        this.r<Json[] | string>('GET', o(org, '/audit-log'), { query: q }),
      members: {
        /** `GET /organizations/:org/members` */
        list: (org: string) => this.r<{ user_id: string; email: string; role: string; project_refs: string[] | null; created_at: string; last_sign_in_at: string | null }[]>('GET', o(org, '/members')),
        /** Change a member's role or project access. `PATCH /organizations/:org/members/:userId` */
        update: (org: string, userId: string, patch: { role?: MemberRole; project_refs?: string[] | null }) => this.r<Json>('PATCH', o(org, `/members/${enc(userId)}`), { body: patch }),
        /** `DELETE /organizations/:org/members/:userId` */
        remove: (org: string, userId: string) => this.r<Json>('DELETE', o(org, `/members/${enc(userId)}`)),
      },
      invitations: {
        /** `GET /organizations/:org/invitations` */
        list: (org: string) => this.r<Json[]>('GET', o(org, '/invitations')),
        /** Invite someone by e-mail. `POST /organizations/:org/invitations` */
        create: (org: string, input: { email: string; role?: MemberRole; project_refs?: string[] }) => this.r<Json>('POST', o(org, '/invitations'), { body: input }),
        /** `DELETE /organizations/:org/invitations/:id` */
        revoke: (org: string, id: string) => this.r<Json>('DELETE', o(org, `/invitations/${enc(id)}`)),
      },
      tokens: {
        /** Organization tokens. `GET /organizations/:org/tokens` */
        list: (org: string) => this.r<Json[]>('GET', o(org, '/tokens')),
        /** Create a token (the secret is shown once). `POST /organizations/:org/tokens` */
        create: (org: string, input: OrgTokenInput) => this.r<Json>('POST', o(org, '/tokens'), { body: input }),
        /** Revoke a token and the project tokens minted from it. `DELETE /organizations/:org/tokens/:id` */
        revoke: (org: string, id: string) => this.r<Json>('DELETE', o(org, `/tokens/${enc(id)}`)),
      },
      apps: {
        /** Third-party apps connected with OAuth. `GET /organizations/:org/apps` */
        list: (org: string) => this.r<Json[]>('GET', o(org, '/apps')),
        /** Disconnect an app. `DELETE /organizations/:org/apps/:id` */
        disconnect: (org: string, id: string) => this.r<{ revoked: string }>('DELETE', o(org, `/apps/${enc(id)}`)),
      },
      webhooks: {
        /** `GET /organizations/:org/webhooks` */
        list: (org: string) => this.r<Json[]>('GET', o(org, '/webhooks')),
        /** Create an endpoint (the signing secret is shown once). `POST /organizations/:org/webhooks` */
        create: (org: string, input: OrgWebhookInput & { url: string }) => this.r<Json>('POST', o(org, '/webhooks'), { body: input }),
        /** `PATCH /organizations/:org/webhooks/:id` */
        update: (org: string, id: string, patch: OrgWebhookInput) => this.r<Json>('PATCH', o(org, `/webhooks/${enc(id)}`), { body: patch }),
        /** `DELETE /organizations/:org/webhooks/:id` */
        delete: (org: string, id: string) => this.r<Json>('DELETE', o(org, `/webhooks/${enc(id)}`)),
        /** Send a test.ping event. `POST /organizations/:org/webhooks/:id/test` */
        test: (org: string, id: string) => this.r<Json>('POST', o(org, `/webhooks/${enc(id)}/test`)),
        /** `POST /organizations/:org/webhooks/:id/rotate-secret` */
        rotateSecret: (org: string, id: string) => this.r<Json>('POST', o(org, `/webhooks/${enc(id)}/rotate-secret`)),
        /** `GET /organizations/:org/webhooks/:id/deliveries` */
        deliveries: (org: string, id: string, q: Query = {}) => this.r<Json[]>('GET', o(org, `/webhooks/${enc(id)}/deliveries`), { query: q }),
        /** `POST /organizations/:org/webhooks/:id/deliveries/:deliveryId/redeliver` */
        redeliver: (org: string, id: string, deliveryId: string) => this.r<Json>('POST', o(org, `/webhooks/${enc(id)}/deliveries/${enc(deliveryId)}/redeliver`)),
      },
    }
  })()

  /** Short-lived project tokens (sdb_prj_…). */
  readonly tokens = {
    /** Active project tokens. `GET /projects/:ref/tokens` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/tokens')),
    /** Mint a token (expires_in 60–86400 s). `POST /projects/:ref/tokens` */
    create: (ref: string, input: ProjectTokenInput = {}) => this.r<Json>('POST', this.p(ref, '/tokens'), { body: input }),
    /** `DELETE /projects/:ref/tokens/:id` */
    revoke: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/tokens/${enc(id)}`)),
  }

  /** Links that hand a project over to someone else's organization. */
  readonly claimLinks = {
    /** `GET /projects/:ref/claim-links` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/claim-links')),
    /** Create a link (organization owner). `POST /projects/:ref/claim-links` */
    create: (ref: string, input: { expires_in_days?: number; keep_role?: string | boolean; note?: string } = {}) => this.r<Json>('POST', this.p(ref, '/claim-links'), { body: input }),
    /** `DELETE /projects/:ref/claim-links/:id` */
    revoke: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/claim-links/${enc(id)}`)),
  }

  /** Auth settings (site URL, redirect URLs, providers, SMTP, …) and SAML SSO providers. */
  readonly authConfig = {
    /** `GET /projects/:ref/config/auth` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/config/auth')),
    /** Change settings (Auth restarts when needed). `PATCH /projects/:ref/config/auth` */
    update: (ref: string, patch: Json) => this.r<Json>('PATCH', this.p(ref, '/config/auth'), { body: patch }),
    sso: {
      /** SAML SSO providers. `GET /projects/:ref/config/auth/sso/providers` */
      list: (ref: string) => this.r<Json>('GET', this.p(ref, '/config/auth/sso/providers')),
      /** Add a SAML provider. `POST /projects/:ref/config/auth/sso/providers` */
      create: (ref: string, input: SsoProviderInput & { domains: string[] }) => this.r<Json>('POST', this.p(ref, '/config/auth/sso/providers'), { body: input }),
      /** `PUT /projects/:ref/config/auth/sso/providers/:id` */
      update: (ref: string, id: string, patch: SsoProviderInput) => this.r<Json>('PUT', this.p(ref, `/config/auth/sso/providers/${enc(id)}`), { body: patch }),
      /** `DELETE /projects/:ref/config/auth/sso/providers/:id` */
      delete: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/config/auth/sso/providers/${enc(id)}`)),
    },
  }

  /** The GraphQL API of a project. */
  readonly graphql = {
    /** State and URL. `GET /projects/:ref/graphql` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/graphql')),
    /** Turn it on or off. `PUT /projects/:ref/graphql` */
    set: (ref: string, enabled: boolean) => this.r<Json>('PUT', this.p(ref, '/graphql'), { body: { enabled } }),
  }

  /** Addresses allowed to connect to Postgres from outside. */
  readonly networkRestrictions = {
    /** `GET /projects/:ref/network-restrictions` */
    get: (ref: string) => this.r<{ allowlist: string[] | null; [k: string]: unknown }>('GET', this.p(ref, '/network-restrictions')),
    /** IPv4 addresses or ranges (null or [] allows all). `PUT /projects/:ref/network-restrictions` */
    set: (ref: string, allowlist: string[] | null) => this.r<{ allowlist: string[] | null; [k: string]: unknown }>('PUT', this.p(ref, '/network-restrictions'), { body: { allowlist } }),
  }

  /** Moving a project to another region. */
  readonly regionMove = {
    /** Regions it can move to, the allowance and the current move. `GET /projects/:ref/region-move` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/region-move')),
    /** Move now, in a quiet hour, or at a time. `POST /projects/:ref/region-move` */
    start: (ref: string, input: { region: string; when?: 'now' | 'quiet' | string }) => this.r<Json>('POST', this.p(ref, '/region-move'), { body: input }),
    /** Cancel a scheduled move. `DELETE /projects/:ref/region-move` */
    cancel: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/region-move')),
  }

  /** Data exposure report and its settings. */
  readonly security = {
    /** What anonymous and signed-in users can read or change. `GET /projects/:ref/security/exposure` */
    exposure: (ref: string, o: { fresh?: boolean } = {}) => this.r<Json>('GET', this.p(ref, '/security/exposure'), { query: { fresh: o.fresh ? '1' : undefined } }),
    /** `GET /projects/:ref/security/settings` */
    settings: (ref: string) => this.r<Json>('GET', this.p(ref, '/security/settings')),
    /** `PATCH /projects/:ref/security/settings` */
    updateSettings: (ref: string, patch: Json) => this.r<Json>('PATCH', this.p(ref, '/security/settings'), { body: patch }),
  }

  /** AI agent keys, their temporary database logins, audit log, approvals and sessions. */
  readonly agents = {
    keys: {
      /** `GET /projects/:ref/agent-keys` */
      list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/agent-keys')),
      /** Create a key (the secret is shown once). `POST /projects/:ref/agent-keys` */
      create: (ref: string, input: AgentKeyInput) => this.r<Json>('POST', this.p(ref, '/agent-keys'), { body: input }),
      /** `PATCH /projects/:ref/agent-keys/:id` */
      update: (ref: string, id: string, patch: AgentKeyInput) => this.r<Json>('PATCH', this.p(ref, `/agent-keys/${enc(id)}`), { body: patch }),
      /** `DELETE /projects/:ref/agent-keys/:id` */
      revoke: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/agent-keys/${enc(id)}`)),
    },
    dbLogins: {
      /** `GET /projects/:ref/agent-keys/:id/db-logins` */
      list: (ref: string, keyId: string) => this.r<Json[]>('GET', this.p(ref, `/agent-keys/${enc(keyId)}/db-logins`)),
      /** A temporary Postgres login with the key's rights. `POST /projects/:ref/agent-keys/:id/db-logins` */
      create: (ref: string, keyId: string, o: { ttl_minutes?: number } = {}) => this.r<Json>('POST', this.p(ref, `/agent-keys/${enc(keyId)}/db-logins`), { body: o }),
      /** End a login now. `DELETE /projects/:ref/agent-keys/:id/db-logins/:loginId` */
      end: (ref: string, keyId: string, loginId: string) => this.r<Json>('DELETE', this.p(ref, `/agent-keys/${enc(keyId)}/db-logins/${enc(loginId)}`)),
    },
    /** What agents ran. `GET /projects/:ref/agent-audit` */
    audit: (ref: string, q: Query = {}) => this.r<Json>('GET', this.p(ref, '/agent-audit'), { query: q }),
    approvals: {
      /** `GET /projects/:ref/agent-approvals?status` */
      list: (ref: string, o: { status?: string } = {}) => this.r<Json[]>('GET', this.p(ref, '/agent-approvals'), { query: o }),
      /** `GET /projects/:ref/agent-approvals/:id` */
      get: (ref: string, id: string) => this.r<Json>('GET', this.p(ref, `/agent-approvals/${enc(id)}`)),
      /** Run the waiting statement. `POST /projects/:ref/agent-approvals/:id/approve` */
      approve: (ref: string, id: string, o: { note?: string } = {}) => this.r<Json>('POST', this.p(ref, `/agent-approvals/${enc(id)}/approve`), { body: o }),
      /** `POST /projects/:ref/agent-approvals/:id/reject` */
      reject: (ref: string, id: string, o: { note?: string } = {}) => this.r<Json>('POST', this.p(ref, `/agent-approvals/${enc(id)}/reject`), { body: o }),
    },
    sessions: {
      /** `GET /projects/:ref/agent-sessions` */
      list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/agent-sessions')),
      /** A session's timeline of changes. `GET /projects/:ref/agent-sessions/:id` */
      get: (ref: string, id: string) => this.r<Json>('GET', this.p(ref, `/agent-sessions/${enc(id)}`)),
      /** Undo a session's changes (a dry run unless `dry_run: false`). `POST /projects/:ref/agent-sessions/:id/revert` */
      revert: (ref: string, id: string, o: { dry_run?: boolean; on_conflict?: 'skip' | string } = {}) => this.r<Json>('POST', this.p(ref, `/agent-sessions/${enc(id)}/revert`), { body: o }),
    },
  }

  /** Importing from another Postgres database. */
  readonly imports = {
    /** Status, check report, progress, result. `GET /projects/:ref/import` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/import')),
    /** Check the source and start. `POST /projects/:ref/import` */
    start: (ref: string, input: { source_uri: string; mode?: 'auto' | 'live' | 'dump'; storage_url?: string; storage_key?: string; api_token?: string }) =>
      this.r<Json>('POST', this.p(ref, '/import'), { body: input }),
    /** Copy the data (and optionally secrets and Auth). `POST /projects/:ref/import/copy` */
    copy: (ref: string, input: { secrets?: string; auth?: unknown } = {}) => this.r<Json>('POST', this.p(ref, '/import/copy'), { body: input }),
    /** Switch over a live copy. `POST /projects/:ref/import/cutover` */
    cutover: (ref: string) => this.r<Json>('POST', this.p(ref, '/import/cutover'), { body: {} }),
    /** Undo the import (`confirm` is the project name). `POST /projects/:ref/import/undo` */
    undo: (ref: string, input: { confirm: string }) => this.r<Json>('POST', this.p(ref, '/import/undo'), { body: input }),
    /** Dismiss a finished import. `DELETE /projects/:ref/import` */
    dismiss: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/import')),
  }

  /** Backups, point-in-time recovery and table restores. */
  readonly backups = {
    /** Backups, the plan's retention and the point-in-time window. `GET /projects/:ref/backups` */
    list: (ref: string) => this.r<Json>('GET', this.p(ref, '/backups')),
    /** Start a manual backup now (one per hour). `POST /projects/:ref/backups` */
    create: (ref: string) => this.r<Json>('POST', this.p(ref, '/backups')),
    /** Restore a backup (the current state is backed up first, so it can be undone). `POST /projects/:ref/backups/:id/restore` */
    restore: (ref: string, id: number | string) => this.r<Json>('POST', this.p(ref, `/backups/${enc(String(id))}/restore`)),
    /** A signed link that streams a fresh dump of the current data. `POST /projects/:ref/backups/export` */
    exportLink: (ref: string) => this.r<Json>('POST', this.p(ref, '/backups/export')),
    /** A signed download link of a backup (`files`: its Storage files). `GET /projects/:ref/backups/:id/download` */
    downloadLink: (ref: string, id: number | string, o: { files?: boolean } = {}) =>
      this.r<Json>('GET', this.p(ref, `/backups/${enc(String(id))}/download`), { query: { files: o.files ? '1' : undefined } }),
    /** The window you can restore to. `GET /projects/:ref/backups/pitr` */
    pitr: (ref: string) => this.r<Json>('GET', this.p(ref, '/backups/pitr')),
    /** Restore to a point in time (with `branch`: into a new preview branch). `POST /projects/:ref/backups/pitr` */
    restoreToTime: (ref: string, input: { target_time: string; branch?: string }) => this.r<Json>('POST', this.p(ref, '/backups/pitr'), { body: input }),
    /** Restore and backup jobs with their progress. `GET /projects/:ref/backups/jobs` */
    jobs: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/backups/jobs')),
    /** One restore or backup job. `GET /projects/:ref/backups/jobs/:id` */
    job: (ref: string, id: number | string) => this.r<Json>('GET', this.p(ref, `/backups/jobs/${enc(String(id))}`)),
    /** Restore one table, or some rows of it, to a point in time. `POST /projects/:ref/backups/table-restore` */
    restoreTable: (ref: string, input: TableRestoreInput) => this.r<Json>('POST', this.p(ref, '/backups/table-restore'), { body: input }),
  }

  /** Compute size of a project. */
  readonly compute = {
    /** The current size, the sizes it can move to and any dedicated server. `GET /projects/:ref/compute` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/compute')),
    /** What a size costs (changes nothing). `POST /projects/:ref/compute/estimate` */
    estimate: (ref: string, input: ComputeInput) => this.r<Json>('POST', this.p(ref, '/compute/estimate'), { body: input }),
    /** Change the size (billed from the prepaid balance). `POST /projects/:ref/compute` */
    change: (ref: string, input: ComputeInput) => this.r<Json>('POST', this.p(ref, '/compute'), { body: input }),
  }

  /** Read replicas, added by hand or automatically. */
  readonly replicas = {
    /** Replicas with their connection details, price and failover state. `GET /projects/:ref/replicas` */
    list: (ref: string) => this.r<Json>('GET', this.p(ref, '/replicas')),
    /** Add a read replica (billed hourly from the prepaid balance). `POST /projects/:ref/replicas` */
    add: (ref: string) => this.r<Json>('POST', this.p(ref, '/replicas')),
    /** Remove a read replica. `DELETE /projects/:ref/replicas/:nodeId` */
    remove: (ref: string, nodeId: string) => this.r<Json>('DELETE', this.p(ref, `/replicas/${enc(nodeId)}`)),
    auto: {
      /** Settings, running replicas and cost. `GET /projects/:ref/auto-replicas` */
      get: (ref: string) => this.r<Json>('GET', this.p(ref, '/auto-replicas')),
      /** Change the automatic replica settings. `PUT /projects/:ref/auto-replicas` */
      set: (ref: string, settings: AutoReplicaSettings) => this.r<Json>('PUT', this.p(ref, '/auto-replicas'), { body: settings }),
    },
  }

  /** The project's budget: limits per resource, alerts and what stops at the limit. */
  readonly budget = {
    /** `GET /projects/:ref/budget` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/budget')),
    /** Set the budget (fields left out keep their value). `PUT /projects/:ref/budget` */
    set: (ref: string, budget: BudgetInput) => this.r<Json>('PUT', this.p(ref, '/budget'), { body: budget }),
    /** Remove the budget. `DELETE /projects/:ref/budget` */
    delete: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/budget')),
    /** Send a test budget alert. `POST /projects/:ref/budget/test` */
    test: (ref: string) => this.r<Json>('POST', this.p(ref, '/budget/test')),
  }

  /** Full exports (database and files) and imports of an export archive. */
  readonly exports = {
    /** Exports and imports with their download / upload links. `GET /projects/:ref/export` */
    list: (ref: string) => this.r<Json>('GET', this.p(ref, '/export')),
    /** Start a full export. `POST /projects/:ref/export` */
    start: (ref: string) => this.r<Json>('POST', this.p(ref, '/export')),
    /** Start an import: returns the upload link for an export archive. `POST /projects/:ref/export/import` */
    startImport: (ref: string) => this.r<Json>('POST', this.p(ref, '/export/import')),
    /** Restore an uploaded archive into this project (organization owner). `POST /projects/:ref/export/import/:jobId/restore` */
    restoreImport: (ref: string, jobId: string, input: Json = {}) => this.r<Json>('POST', this.p(ref, `/export/import/${enc(jobId)}/restore`), { body: input }),
    /** Delete an export or import. `DELETE /projects/:ref/export/:jobId` */
    delete: (ref: string, jobId: string) => this.r<Json>('DELETE', this.p(ref, `/export/${enc(jobId)}`)),
  }

  /** Feature flags and segments. */
  readonly flags = {
    /** State, flags and segments. `GET /projects/:ref/flags` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/flags')),
    /** Turn feature flags on. `POST /projects/:ref/flags` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/flags')),
    /** Turn feature flags off. `DELETE /projects/:ref/flags` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/flags')),
    /** Create a flag. `POST /projects/:ref/flags/flags` */
    create: (ref: string, input: FlagInput & { key: string }) => this.r<Json>('POST', this.p(ref, '/flags/flags'), { body: input }),
    /** Change a flag (rules, rollout, variations, enabled, archived). `PATCH /projects/:ref/flags/flags/:key` */
    update: (ref: string, key: string, patch: FlagInput) => this.r<Json>('PATCH', this.p(ref, `/flags/flags/${enc(key)}`), { body: patch }),
    /** Delete an archived flag. `DELETE /projects/:ref/flags/flags/:key` */
    delete: (ref: string, key: string) => this.r<Json>('DELETE', this.p(ref, `/flags/flags/${enc(key)}`)),
    /** How often a flag was evaluated, per variation. `GET /projects/:ref/flags/flags/:key/stats` */
    stats: (ref: string, key: string) => this.r<Json>('GET', this.p(ref, `/flags/flags/${enc(key)}/stats`)),
    segments: {
      /** `POST /projects/:ref/flags/segments` */
      create: (ref: string, input: SegmentInput & { key: string }) => this.r<Json>('POST', this.p(ref, '/flags/segments'), { body: input }),
      /** `PATCH /projects/:ref/flags/segments/:key` */
      update: (ref: string, key: string, patch: SegmentInput) => this.r<Json>('PATCH', this.p(ref, `/flags/segments/${enc(key)}`), { body: patch }),
      /** `DELETE /projects/:ref/flags/segments/:key` */
      delete: (ref: string, key: string) => this.r<Json>('DELETE', this.p(ref, `/flags/segments/${enc(key)}`)),
    },
    /** Change history of flags and segments. `GET /projects/:ref/flags/history` */
    history: (ref: string, q: Query = {}) => this.r<Json>('GET', this.p(ref, '/flags/history'), { query: q }),
    /** Restore a flag or segment from its history (the state `before` or `after` that change). `POST /projects/:ref/flags/history/:id/restore` */
    restore: (ref: string, historyId: number | string, o: { side?: 'before' | 'after' } = {}) =>
      this.r<Json>('POST', this.p(ref, `/flags/history/${enc(String(historyId))}/restore`), { body: o }),
    /** Evaluate the flags for a test context (changes nothing). `POST /projects/:ref/flags/test` */
    test: (ref: string, input: { user?: Json; anon_id?: string; attributes?: Json; key?: string; [k: string]: unknown }) =>
      this.r<Json>('POST', this.p(ref, '/flags/test'), { body: input }),
  }

  /** API rate limit rules. */
  readonly rateLimits = {
    /** Rules and recent blocks. `GET /projects/:ref/rate-limits` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/rate-limits')),
    /** Replace the rules. `PATCH /projects/:ref/rate-limits` */
    update: (ref: string, rules: Json[]) => this.r<Json>('PATCH', this.p(ref, '/rate-limits'), { body: { rules } }),
    /** Install the SQL rate-limit function in the database. `POST /projects/:ref/rate-limits/sql` */
    installSql: (ref: string) => this.r<Json>('POST', this.p(ref, '/rate-limits/sql')),
    /** Remove the SQL rate-limit function. `DELETE /projects/:ref/rate-limits/sql` */
    removeSql: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/rate-limits/sql')),
  }

  /** Inbound webhooks: endpoints that receive and verify events from other services. */
  readonly inbound = {
    /** State and endpoints. `GET /projects/:ref/inbound` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/inbound')),
    /** `POST /projects/:ref/inbound` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/inbound')),
    /** `DELETE /projects/:ref/inbound` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/inbound')),
    endpoints: {
      /** Add an endpoint (provider, signing secret, handler). `POST /projects/:ref/inbound/endpoints` */
      create: (ref: string, input: InboundEndpointInput & { slug: string }) => this.r<Json>('POST', this.p(ref, '/inbound/endpoints'), { body: input }),
      /** `PATCH /projects/:ref/inbound/endpoints/:slug` */
      update: (ref: string, slug: string, patch: InboundEndpointInput) => this.r<Json>('PATCH', this.p(ref, `/inbound/endpoints/${enc(slug)}`), { body: patch }),
      /** Delete an endpoint (`events`: its events too). `DELETE /projects/:ref/inbound/endpoints/:slug` */
      delete: (ref: string, slug: string, o: { events?: boolean } = {}) =>
        this.r<Json>('DELETE', this.p(ref, `/inbound/endpoints/${enc(slug)}`), { query: { events: o.events ? '1' : undefined } }),
      /** Send a test event. `POST /projects/:ref/inbound/endpoints/:slug/test` */
      test: (ref: string, slug: string, payload: Json = {}) => this.r<Json>('POST', this.p(ref, `/inbound/endpoints/${enc(slug)}/test`), { body: payload }),
    },
    events: {
      /** Received events. `GET /projects/:ref/inbound/events?endpoint&status&limit&before` */
      list: (ref: string, q: { endpoint?: string; status?: string; limit?: number; before?: string | number } = {}) => this.r<Json>('GET', this.p(ref, '/inbound/events'), { query: q }),
      /** One event with its payload. `GET /projects/:ref/inbound/events/:id` */
      get: (ref: string, id: number | string) => this.r<Json>('GET', this.p(ref, `/inbound/events/${enc(String(id))}`)),
      /** Process an event again. `POST /projects/:ref/inbound/events/:id/redeliver` */
      redeliver: (ref: string, id: number | string) => this.r<Json>('POST', this.p(ref, `/inbound/events/${enc(String(id))}/redeliver`)),
      /** `DELETE /projects/:ref/inbound/events/:id` */
      delete: (ref: string, id: number | string) => this.r<Json>('DELETE', this.p(ref, `/inbound/events/${enc(String(id))}`)),
    },
  }

  /** The project's public status page. */
  readonly statusPage = {
    /** State, settings, components and incidents. `GET /projects/:ref/status-page` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/status-page')),
    /** `POST /projects/:ref/status-page` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/status-page')),
    /** `DELETE /projects/:ref/status-page` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/status-page')),
    /** Change the page (title, components, checks, notifications). `PUT /projects/:ref/status-page/settings` */
    update: (ref: string, settings: Json) => this.r<Json>('PUT', this.p(ref, '/status-page/settings'), { body: settings }),
    incidents: {
      /** Post an incident or scheduled maintenance. `POST /projects/:ref/status-page/incidents` */
      create: (ref: string, input: IncidentInput & { title: string; message: string }) => this.r<Json>('POST', this.p(ref, '/status-page/incidents'), { body: input }),
      /** Add an update (`status`, `message`) or change the incident. `PATCH /projects/:ref/status-page/incidents/:id` */
      update: (ref: string, incidentId: string, patch: IncidentInput) => this.r<Json>('PATCH', this.p(ref, `/status-page/incidents/${enc(incidentId)}`), { body: patch }),
      /** `DELETE /projects/:ref/status-page/incidents/:id` */
      delete: (ref: string, incidentId: string) => this.r<Json>('DELETE', this.p(ref, `/status-page/incidents/${enc(incidentId)}`)),
      /** Edit a posted update. `PATCH /projects/:ref/status-page/incidents/:id/updates/:updateId` */
      editUpdate: (ref: string, incidentId: string, updateId: number | string, patch: { message?: string; status?: string; [k: string]: unknown }) =>
        this.r<Json>('PATCH', this.p(ref, `/status-page/incidents/${enc(incidentId)}/updates/${enc(String(updateId))}`), { body: patch }),
    },
    subscribers: {
      /** E-mail subscribers. `GET /projects/:ref/status-page/subscribers` */
      list: (ref: string) => this.r<Json>('GET', this.p(ref, '/status-page/subscribers')),
      /** `DELETE /projects/:ref/status-page/subscribers/:id` */
      remove: (ref: string, id: number | string) => this.r<Json>('DELETE', this.p(ref, `/status-page/subscribers/${enc(String(id))}`)),
    },
  }

  /** Scheduled jobs (pg_cron). */
  readonly cron = {
    /** Jobs with their last run. `GET /projects/:ref/cron/jobs` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/cron/jobs')),
    /** Recent runs (of one job with `jobid`). `GET /projects/:ref/cron/runs?jobid` */
    runs: (ref: string, q: { jobid?: number | string } = {}) => this.r<Json[]>('GET', this.p(ref, '/cron/runs'), { query: q }),
    /** Schedule a job. `POST /projects/:ref/cron/jobs` */
    create: (ref: string, input: CronJobInput & { schedule: string; command: string }) => {
      const { name, ...rest } = input
      return this.r<{ jobid: number }>('POST', this.p(ref, '/cron/jobs'), { body: { ...rest, jobname: input.jobname ?? name } })
    },
    /** Change the schedule, command or active state. `PATCH /projects/:ref/cron/jobs/:id` */
    update: (ref: string, id: number | string, patch: { schedule?: string; command?: string; active?: boolean }) =>
      this.r<Json>('PATCH', this.p(ref, `/cron/jobs/${enc(String(id))}`), { body: patch }),
    /** Unschedule a job. `DELETE /projects/:ref/cron/jobs/:id` */
    delete: (ref: string, id: number | string) => this.r<Json>('DELETE', this.p(ref, `/cron/jobs/${enc(String(id))}`)),
  }

  /** Message queues (pgmq). */
  readonly queues = {
    /** Queues with their length and age. `GET /projects/:ref/queues` */
    list: (ref: string) => this.r<Json[]>('GET', this.p(ref, '/queues')),
    /** Create a queue. `POST /projects/:ref/queues` */
    create: (ref: string, input: { name: string; type?: 'standard' | 'unlogged' | 'partitioned' }) =>
      this.r<Json>('POST', this.p(ref, '/queues'), { body: { ...input, ...(input.type === 'unlogged' ? { unlogged: true } : {}) } }),
    /** Delete a queue and its messages. `DELETE /projects/:ref/queues/:name` */
    delete: (ref: string, name: string) => this.r<Json>('DELETE', this.p(ref, `/queues/${enc(name)}`)),
    /** The newest messages (`archived`: the archive). `GET /projects/:ref/queues/:name/messages` */
    messages: (ref: string, name: string, q: { archived?: boolean } = {}) =>
      this.r<Json[]>('GET', this.p(ref, `/queues/${enc(name)}/messages`), { query: { archived: q.archived ? 'true' : undefined } }),
    /** Send a message (`delay` in seconds). `POST /projects/:ref/queues/:name/messages` */
    send: (ref: string, name: string, input: { message: unknown; delay?: number }) => this.r<{ msg_id: number }>('POST', this.p(ref, `/queues/${enc(name)}/messages`), { body: input }),
    /** Read up to `qty` messages; they stay invisible for `vt` seconds. `POST /projects/:ref/queues/:name/read` */
    read: (ref: string, name: string, input: { vt?: number; qty?: number } = {}) => this.r<Json[]>('POST', this.p(ref, `/queues/${enc(name)}/read`), { body: input }),
    /** Move a message to the archive. `POST /projects/:ref/queues/:name/messages/:msgId/archive` */
    archive: (ref: string, name: string, msgId: number | string) => this.r<Json>('POST', this.p(ref, `/queues/${enc(name)}/messages/${enc(String(msgId))}/archive`)),
    /** Delete a message. `POST /projects/:ref/queues/:name/messages/:msgId/delete` */
    deleteMessage: (ref: string, name: string, msgId: number | string) => this.r<Json>('POST', this.p(ref, `/queues/${enc(name)}/messages/${enc(String(msgId))}/delete`)),
  }

  /** Push notification credentials (APNs, FCM). */
  readonly push = {
    /** Credentials on file (never the keys), devices, recent messages. `GET /projects/:ref/push` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/push')),
    /** Set (or with null remove) the APNs .p8 key or the FCM service account. `PATCH /projects/:ref/push` */
    configure: (ref: string, input: PushConfigInput) => this.r<Json>('PATCH', this.p(ref, '/push'), { body: input }),
    /** Send a test notification to a user. `POST /projects/:ref/push/test` */
    test: (ref: string, input: { user_id: string; title?: string; body?: string; inbox?: boolean }) => this.r<{ id: number }>('POST', this.p(ref, '/push/test'), { body: input }),
    /** Turn push off and remove the credentials. `DELETE /projects/:ref/push` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/push')),
  }

  /** In-app purchases (App Store, Google Play). */
  readonly purchases = {
    /** Store credentials on file (never the keys), products, webhooks, deliveries. `GET /projects/:ref/purchases` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/purchases')),
    /** Set store credentials, products and webhooks. `PATCH /projects/:ref/purchases` */
    configure: (ref: string, input: Json) => this.r<Json>('PATCH', this.p(ref, '/purchases'), { body: input }),
    /** Send a test event to a purchase webhook. `POST /projects/:ref/purchases/webhooks/:id/test` */
    testWebhook: (ref: string, id: string) => this.r<Json>('POST', this.p(ref, `/purchases/webhooks/${enc(id)}/test`)),
    /** Deliver a failed webhook again. `POST /projects/:ref/purchases/deliveries/:id/retry` */
    retryDelivery: (ref: string, id: number | string) => this.r<Json>('POST', this.p(ref, `/purchases/deliveries/${enc(String(id))}/retry`)),
    /** Turn purchases off and remove the credentials. `DELETE /projects/:ref/purchases` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/purchases')),
  }

  /** Deep links and short links. */
  readonly links = {
    /** State and settings. `GET /projects/:ref/links` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/links')),
    /** `POST /projects/:ref/links` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/links')),
    /** `DELETE /projects/:ref/links` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/links')),
    /** Apps, app stores, fallback and domain. `PUT /projects/:ref/links/settings` */
    updateSettings: (ref: string, settings: Json) => this.r<Json>('PUT', this.p(ref, '/links/settings'), { body: settings }),
    items: {
      /** Short links. `GET /projects/:ref/links/items?q&limit&offset` */
      list: (ref: string, q: { q?: string; limit?: number; offset?: number } = {}) => this.r<Json>('GET', this.p(ref, '/links/items'), { query: q }),
      /** Create a short link. `POST /projects/:ref/links/items` */
      create: (ref: string, input: LinkInput) => this.r<Json>('POST', this.p(ref, '/links/items'), { body: input }),
      /** One link with its click statistics. `GET /projects/:ref/links/items/:code?days` */
      get: (ref: string, code: string, q: { days?: number } = {}) => this.r<Json>('GET', this.p(ref, `/links/items/${enc(code)}`), { query: q }),
      /** `PATCH /projects/:ref/links/items/:code` */
      update: (ref: string, code: string, patch: LinkInput) => this.r<Json>('PATCH', this.p(ref, `/links/items/${enc(code)}`), { body: patch }),
      /** `DELETE /projects/:ref/links/items/:code` */
      delete: (ref: string, code: string) => this.r<Json>('DELETE', this.p(ref, `/links/items/${enc(code)}`)),
    },
  }

  /** Usage metering of your own customers, and the push to Stripe. */
  readonly metering = {
    /** State, meters, alerts and the Stripe push (key masked). `GET /projects/:ref/metering` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/metering')),
    /** `POST /projects/:ref/metering` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/metering')),
    /** `DELETE /projects/:ref/metering` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/metering')),
    /** Meters, plans and alerts. `PUT /projects/:ref/metering/settings` */
    updateSettings: (ref: string, settings: Json) => this.r<Json>('PUT', this.p(ref, '/metering/settings'), { body: settings }),
    /** The Stripe push (secret key, meters). `PUT /projects/:ref/metering/stripe` */
    setStripe: (ref: string, input: Json) => this.r<Json>('PUT', this.p(ref, '/metering/stripe'), { body: input }),
    /** End customers and their Stripe customer ids. `GET /projects/:ref/metering/stripe/customers` */
    stripeCustomers: (ref: string, q: Query = {}) => this.r<Json>('GET', this.p(ref, '/metering/stripe/customers'), { query: q }),
    /** Set Stripe customer ids of end customers. `PUT /projects/:ref/metering/stripe/customers` */
    setStripeCustomers: (ref: string, input: Json) => this.r<Json>('PUT', this.p(ref, '/metering/stripe/customers'), { body: input }),
    /** Push failed usage to Stripe again. `POST /projects/:ref/metering/stripe/retry` */
    retryStripe: (ref: string) => this.r<Json>('POST', this.p(ref, '/metering/stripe/retry')),
    /** Usage per end customer. `GET /projects/:ref/metering/customers?from&to&meter&q&limit` */
    customers: (ref: string, q: { from?: string; to?: string; meter?: string; q?: string; limit?: number } = {}) => this.r<Json>('GET', this.p(ref, '/metering/customers'), { query: q }),
    /** Daily usage of one end customer. `GET /projects/:ref/metering/customers/:id` */
    customer: (ref: string, id: string, q: { from?: string; to?: string; meter?: string } = {}) => this.r<Json>('GET', this.p(ref, `/metering/customers/${enc(id)}`), { query: q }),
    /** Usage as CSV text. `GET /projects/:ref/metering/export?from&to&meter` */
    export: (ref: string, q: { from?: string; to?: string; meter?: string } = {}) =>
      this.r<string>('GET', this.p(ref, '/metering/export'), { query: q, headers: { Accept: 'text/csv, text/plain, */*' } }),
  }

  /** Job monitoring (heartbeats of cron jobs, background jobs and outside jobs). */
  readonly heartbeat = {
    /** State, alert settings and monitors. `GET /projects/:ref/heartbeat` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/heartbeat')),
    /** `POST /projects/:ref/heartbeat` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/heartbeat')),
    /** `DELETE /projects/:ref/heartbeat` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/heartbeat')),
    /** Alert settings (e-mail, webhook, Slack). `PUT /projects/:ref/heartbeat/settings` */
    updateSettings: (ref: string, settings: Json) => this.r<Json>('PUT', this.p(ref, '/heartbeat/settings'), { body: settings }),
    /** Send a test alert. `POST /projects/:ref/heartbeat/test` */
    test: (ref: string) => this.r<Json>('POST', this.p(ref, '/heartbeat/test')),
    monitors: {
      /** Add a monitor. `POST /projects/:ref/heartbeat/monitors` */
      create: (ref: string, input: MonitorInput & { kind: 'ping' | 'cron' | 'job'; name: string }) => this.r<Json>('POST', this.p(ref, '/heartbeat/monitors'), { body: input }),
      /** One monitor with its recent pings. `GET /projects/:ref/heartbeat/monitors/:id?limit` */
      get: (ref: string, id: number | string, q: { limit?: number } = {}) => this.r<Json>('GET', this.p(ref, `/heartbeat/monitors/${enc(String(id))}`), { query: q }),
      /** `PATCH /projects/:ref/heartbeat/monitors/:id` */
      update: (ref: string, id: number | string, patch: MonitorInput) => this.r<Json>('PATCH', this.p(ref, `/heartbeat/monitors/${enc(String(id))}`), { body: patch }),
      /** `DELETE /projects/:ref/heartbeat/monitors/:id` */
      delete: (ref: string, id: number | string) => this.r<Json>('DELETE', this.p(ref, `/heartbeat/monitors/${enc(String(id))}`)),
      /** A new ping URL (the old one stops working). `POST /projects/:ref/heartbeat/monitors/:id/token` */
      rotateToken: (ref: string, id: number | string) => this.r<Json>('POST', this.p(ref, `/heartbeat/monitors/${enc(String(id))}/token`)),
    },
  }

  /** Crash reporting. */
  readonly crashes = {
    /** State and alert settings. `GET /projects/:ref/crashes` */
    get: (ref: string) => this.r<Json>('GET', this.p(ref, '/crashes')),
    /** `POST /projects/:ref/crashes` */
    enable: (ref: string) => this.r<Json>('POST', this.p(ref, '/crashes')),
    /** `DELETE /projects/:ref/crashes` */
    disable: (ref: string) => this.r<Json>('DELETE', this.p(ref, '/crashes')),
    /** Alerts on new issues, regressions and spikes (e-mail, webhook, Slack). `PUT /projects/:ref/crashes/settings` */
    updateSettings: (ref: string, settings: Json) => this.r<Json>('PUT', this.p(ref, '/crashes/settings'), { body: settings }),
    /** Send a test alert. `POST /projects/:ref/crashes/test` */
    test: (ref: string) => this.r<Json>('POST', this.p(ref, '/crashes/test')),
    issues: {
      /** `GET /projects/:ref/crashes/issues?status&release&q&limit&offset` */
      list: (ref: string, q: { status?: string; release?: string; q?: string; limit?: number; offset?: number } = {}) => this.r<Json>('GET', this.p(ref, '/crashes/issues'), { query: q }),
      /** One issue with its latest events. `GET /projects/:ref/crashes/issues/:id` */
      get: (ref: string, id: number | string) => this.r<Json>('GET', this.p(ref, `/crashes/issues/${enc(String(id))}`)),
      /** Resolve, ignore or reopen. `PATCH /projects/:ref/crashes/issues/:id` */
      update: (ref: string, id: number | string, patch: { status: 'open' | 'resolved' | 'ignored' }) =>
        this.r<Json>('PATCH', this.p(ref, `/crashes/issues/${enc(String(id))}`), { body: patch }),
    },
  }

  /** Deleted rows kept by the recycle bin. */
  readonly recycleBin = {
    /** Deleted rows and the tables the bin covers. `GET /projects/:ref/recycle-bin?table&limit` */
    get: (ref: string, q: { table?: string; limit?: number } = {}) => this.r<Json>('GET', this.p(ref, '/recycle-bin'), { query: q }),
    /** Turn the bin on or off for a table. `PUT /projects/:ref/recycle-bin/tables` */
    setTable: (ref: string, input: TrackTableInput) => this.r<Json>('PUT', this.p(ref, '/recycle-bin/tables'), { body: input }),
    /** Restore deleted rows. `POST /projects/:ref/recycle-bin/restore` */
    restore: (ref: string, ids: (number | string)[]) => this.r<Json>('POST', this.p(ref, '/recycle-bin/restore'), { body: { ids } }),
    /** Delete rows from the bin for good. `POST /projects/:ref/recycle-bin/purge` */
    purge: (ref: string, ids: (number | string)[]) => this.r<Json>('POST', this.p(ref, '/recycle-bin/purge'), { body: { ids } }),
  }

  /** Row change history. */
  readonly history = {
    /** Row changes and the tables that keep a history. `GET /projects/:ref/history?table&pk&limit&before` */
    get: (ref: string, q: { table?: string; pk?: string; limit?: number; before?: string | number } = {}) => this.r<Json>('GET', this.p(ref, '/history'), { query: q }),
    /** Turn the history on or off for a table. `PUT /projects/:ref/history/tables` */
    setTable: (ref: string, input: TrackTableInput) => this.r<Json>('PUT', this.p(ref, '/history/tables'), { body: input }),
    /** Revert one change. `POST /projects/:ref/history/revert` */
    revert: (ref: string, id: number | string) => this.r<Json>('POST', this.p(ref, '/history/revert'), { body: { id } }),
  }

  /** Shared table views: read-only (or editable) links for people without dashboard access. */
  readonly sharedViews = {
    /** `GET /projects/:ref/shared-views` */
    list: (ref: string) => this.r<Json>('GET', this.p(ref, '/shared-views')),
    /** `POST /projects/:ref/shared-views` */
    create: (ref: string, input: SharedViewInput & { name: string; table: string }) => this.r<Json>('POST', this.p(ref, '/shared-views'), { body: input }),
    /** One view with its members. `GET /projects/:ref/shared-views/:id` */
    get: (ref: string, id: string) => this.r<Json>('GET', this.p(ref, `/shared-views/${enc(id)}`)),
    /** `PATCH /projects/:ref/shared-views/:id` */
    update: (ref: string, id: string, patch: SharedViewInput) => this.r<Json>('PATCH', this.p(ref, `/shared-views/${enc(id)}`), { body: patch }),
    /** `DELETE /projects/:ref/shared-views/:id` */
    delete: (ref: string, id: string) => this.r<Json>('DELETE', this.p(ref, `/shared-views/${enc(id)}`)),
    /** Give people access by e-mail (`send: false` skips the invitation e-mail). `POST /projects/:ref/shared-views/:id/members` */
    addMembers: (ref: string, id: string, emails: string[], o: { send?: boolean; resend?: boolean } = {}) =>
      this.r<Json>('POST', this.p(ref, `/shared-views/${enc(id)}/members`), { body: { emails, ...o } }),
    /** `DELETE /projects/:ref/shared-views/:id/members?email` */
    removeMember: (ref: string, id: string, email: string) => this.r<Json>('DELETE', this.p(ref, `/shared-views/${enc(id)}/members`), { query: { email } }),
    /** Who opened the view and when. `GET /projects/:ref/shared-views/:id/audit` */
    audit: (ref: string, id: string, q: { limit?: number; before?: number } = {}) => this.r<Json>('GET', this.p(ref, `/shared-views/${enc(id)}/audit`), { query: q }),
  }

  /** Prices. */
  readonly billing = {
    /** What a change would cost on the organization's plan (`project_ref` picks the organization). `POST /billing/estimate` */
    estimate: (input: { project_ref?: string; change?: Json; [k: string]: unknown }) => this.r<Json>('POST', '/billing/estimate', { body: input }),
  }
}

/** A Management API client. */
export function createManagementClient(options: ManagementClientOptions): ManagementClient {
  return new ManagementClient(options)
}

// ---------- agent client ----------
/**
 * The client for an AI agent's own key (sdb_agt_…): its SQL runs under the key's policy (firewall, approvals, query
 * log, undo). A statement that needs a person's approval resolves with `status: 'pending_approval'` and an approval id.
 */
export class AgentClient {
  private t: Transport
  constructor(options: AgentClientOptions) {
    this.t = new Transport(options?.agentKey, options || ({} as AgentClientOptions))
  }
  /** Any endpoint the key may call (paths relative to /platform/v1). */
  request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<MgmtResult<T>> { return this.t.request<T>(method, path, options) }

  /** The key's name, project and policy. `GET /agent` */
  whoami(): Promise<MgmtResult<{ agent: string; key_id: string; project_ref: string; api_url: string; policy: Json }>> { return this.t.request('GET', '/agent') }
  /** Run SQL; `session` groups statements so they can be undone together. `POST /agent/sql` */
  sql(query: string, o: { session?: string } = {}): Promise<MgmtResult<QueryResult>> {
    return this.t.request('POST', '/agent/sql', { body: { query }, headers: o.session ? { 'X-Stitch-Session': o.session } : undefined })
  }
  /** A temporary Postgres login with the key's rights. `POST /agent/db-credentials` */
  dbCredentials(o: { ttl_minutes?: number } = {}): Promise<MgmtResult<Json>> { return this.t.request('POST', '/agent/db-credentials', { body: o }) }
  /** The key's current logins. `GET /agent/db-credentials` */
  listDbCredentials(): Promise<MgmtResult<Json[]>> { return this.t.request('GET', '/agent/db-credentials') }
  /** The state of an approval request. `GET /agent/approvals/:id` */
  approval(id: string): Promise<MgmtResult<Json>> { return this.t.request('GET', `/agent/approvals/${enc(id)}`) }
  /** A session's timeline. `GET /agent/sessions/:id` */
  session(id: string): Promise<MgmtResult<Json>> { return this.t.request('GET', `/agent/sessions/${enc(id)}`) }
  /** Undo a session's changes (a dry run unless `dry_run: false`). `POST /agent/sessions/:id/revert` */
  revert(id: string, o: { dry_run?: boolean } = {}): Promise<MgmtResult<Json>> { return this.t.request('POST', `/agent/sessions/${enc(id)}/revert`, { body: o }) }
}

/** A client for an agent key. */
export function createAgentClient(options: AgentClientOptions): AgentClient {
  return new AgentClient(options)
}
