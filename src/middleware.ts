/**
 * Middleware for Web Fetch handlers: Edge Functions, Deno, Bun, Cloudflare Workers, Vercel and Node.
 *
 * `pipeline([...], handler)` returns a `(request) => Promise<Response>` handler. Each middleware adds one typed key
 * to a shared `ctx`, can answer early with a `Response`, and can change the response on the way out. Duplicate keys
 * and middleware placed before the ones they need are type errors.
 *
 * @example
 * ```ts
 * import { pipeline, withCors, withClaims, withStitchClient } from 'stitchdb-js/middleware'
 *
 * Deno.serve(pipeline([withCors(), withClaims(), withStitchClient()], async (req, ctx) => {
 *   const { data, error } = await ctx.stitch.from('todos').select()
 *   if (error) throw error
 *   return Response.json({ user: ctx.claims?.sub ?? null, todos: data })
 * }))
 * ```
 *
 * @module middleware
 */
import { createClient } from './index'
import type StitchClient from './StitchClient'
import type { JwtPayload } from './auth/lib/types'
import { corsHeaders } from './cors'

// ---------- types ----------

/**
 * Types of the keys that middleware adds to `ctx`, for `requires` in {@link defineMiddleware}.
 * Add your own with declaration merging:
 * ```ts
 * declare module 'stitchdb-js/middleware' { interface MiddlewareContext { tenant: { id: string } } }
 * ```
 */
export interface MiddlewareContext {
  requestId: string
  cors: CorsInfo
  claims: Claims | null
  stitch: StitchClient<any, any, any>
  stitchAdmin: StitchClient<any, any, any>
  pg: PgUserClient
  pgAdmin: PostgresSql
  rateLimit: RateLimitInfo
}

/** The verified JWT claims of the caller. */
export type Claims = JwtPayload & { role?: string; sub?: string; [key: string]: unknown }

type CtxFor<R extends string> = { readonly [K in R]: K extends keyof MiddlewareContext ? MiddlewareContext[K] : unknown }

/** One pipeline entry. Create it with {@link defineMiddleware}. */
export interface Middleware<K extends string = string, V = unknown, R extends string = string> {
  readonly key: K
  readonly requires?: readonly R[]
  /** Returns the value stored at `ctx[key]`, or a `Response` to answer right away. */
  run(req: Request, ctx: any): V | Response | Promise<V | Response>
  /** Runs on the way out (last middleware first), also for errors and early responses of later middleware. */
  after?(res: Response, req: Request, ctx: any): Response | void | Promise<Response | void>
  /** @internal type marker for the value */
  readonly _value?: V
}

type AnyMiddleware = Middleware<string, any, string>
type KeyOf<M> = M extends Middleware<infer K, any, any> ? K : never
type ValueOf<M> = M extends Middleware<any, infer V, any> ? V : never
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** The `ctx` a handler gets from a list of middleware. */
export type ContextOf<T extends readonly AnyMiddleware[]> = Simplify<{ readonly [M in T[number] as KeyOf<M>]: ValueOf<M> }>

/** `'ok'`, or a message naming the duplicate key or the missing middleware. */
export type CheckPipeline<T extends readonly AnyMiddleware[], Seen extends string = never> =
  T extends readonly [infer H, ...infer Rest extends readonly AnyMiddleware[]]
    ? H extends Middleware<infer K, any, infer R>
      ? [K] extends [Seen]
        ? `Duplicate middleware key "${K}"`
        : [Exclude<R, Seen>] extends [never]
          ? CheckPipeline<Rest, Seen | K>
          : `Middleware "${K}" needs "${Exclude<R, Seen> & string}" earlier in the pipeline`
      : 'ok'
    : 'ok'

export type Handler<C> = (req: Request, ctx: C) => Response | Promise<Response>

/**
 * Defines a middleware entry. `key` names the value it adds to `ctx`; `requires` lists keys that must come earlier.
 *
 * @example
 * ```ts
 * const withTenant = defineMiddleware({
 *   key: 'tenant',
 *   requires: ['claims'],
 *   run: (req, ctx) => ({ id: String(ctx.claims?.app_metadata?.tenant ?? 'public') }),
 * })
 * ```
 */
export function defineMiddleware<const K extends string, V, const R extends string = never>(m: {
  key: K
  requires?: readonly R[]
  run(req: Request, ctx: CtxFor<R>): V | Response | Promise<V | Response>
  after?(res: Response, req: Request, ctx: CtxFor<R> & { readonly [P in K]?: V }): Response | void | Promise<Response | void>
}): Middleware<K, Exclude<V, Response>, R> {
  if (!m || typeof m.key !== 'string' || !m.key) throw new TypeError('defineMiddleware: key is required')
  if (typeof m.run !== 'function') throw new TypeError(`defineMiddleware: run is required (${m.key})`)
  return m as unknown as Middleware<K, Exclude<V, Response>, R>
}

// ---------- errors ----------

/** Throw from a handler or middleware to answer with this status and a JSON body `{ code, message }`. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers?: HeadersInit
  constructor(status: number, message: string, options: { code?: string; headers?: HeadersInit; cause?: unknown } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = options.code || codeFor(status)
    this.headers = options.headers
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

const CODES: Record<number, string> = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 422: 'unprocessable_entity', 429: 'rate_limited', 500: 'internal_error' }
const codeFor = (status: number) => CODES[status] || (status >= 500 ? 'internal_error' : 'error')

/** A JSON error response `{ code, message }`. */
export function errorResponse(status: number, message: string, code = codeFor(status), headers?: HeadersInit): Response {
  const h = new Headers(headers)
  h.set('Content-Type', 'application/json')
  return new Response(JSON.stringify({ code, message }), { status, headers: h })
}

function toResponse(e: unknown): Response {
  if (e instanceof HttpError) return errorResponse(e.status, e.message, e.code, e.headers)
  console.error('[stitchdb middleware] unhandled error:', e)
  return errorResponse(500, 'Internal error')
}

/** A copy of `res` with headers set (responses from `fetch()` have read-only headers). */
export function withHeaders(res: Response, headers: Record<string, string | null | undefined>): Response {
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) h.delete(k)
    else h.set(k, v)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

// ---------- pipeline ----------

const ENV = Symbol.for('stitchdb.middleware.env')

/**
 * Runs `middleware` in order, then `handler(req, ctx)`. Errors become JSON responses (`HttpError` keeps its status,
 * anything else is a 500 and is logged). Returns a Web Fetch handler; on Cloudflare Workers the `env` argument is used
 * for `STITCHDB_*` settings.
 */
export function pipeline<const T extends readonly AnyMiddleware[]>(
  middleware: T,
  handler: CheckPipeline<T> extends 'ok' ? Handler<ContextOf<T>> : CheckPipeline<T>
): (req: Request, ...rest: any[]) => Promise<Response> {
  const list = [...middleware] as AnyMiddleware[]
  const seen = new Set<string>()
  for (const m of list) {
    if (seen.has(m.key)) throw new TypeError(`Duplicate middleware key "${m.key}"`)
    for (const r of m.requires || []) if (!seen.has(r)) throw new TypeError(`Middleware "${m.key}" needs "${r}" earlier in the pipeline`)
    seen.add(m.key)
  }
  if (typeof handler !== 'function') throw new TypeError('pipeline: handler must be a function')
  const run = handler as Handler<any>
  return async (req: Request, ...rest: any[]) => {
    const ctx: Record<string | symbol, unknown> = {}
    const workersEnv = rest[0]
    if (workersEnv && typeof workersEnv === 'object') ctx[ENV] = workersEnv
    const ran: AnyMiddleware[] = []
    let res: Response | undefined
    try {
      for (const m of list) {
        const v = await m.run(req, ctx)
        if (v instanceof Response) { res = v; break }
        ctx[m.key] = v
        ran.push(m)
      }
      if (!res) {
        res = await run(req, ctx)
        if (!(res instanceof Response)) throw new TypeError('The handler must return a Response')
      }
    } catch (e) {
      res = toResponse(e)
    }
    for (const m of ran.reverse()) {
      if (!m.after) continue
      try {
        const out = await m.after(res, req, ctx)
        if (out instanceof Response) res = out
      } catch (e) {
        res = toResponse(e)
      }
    }
    return res
  }
}

// ---------- settings ----------

function envOf(ctx: any, name: string): string | undefined {
  const w = ctx?.[ENV]
  if (w && typeof w[name] === 'string') return w[name]
  const g = globalThis as any
  try {
    const v = g.Deno?.env?.get?.(name)
    if (v) return v
  } catch { /* no permission */ }
  return g.process?.env?.[name] || undefined
}
function setting(ctx: any, given: string | undefined, names: string[], what: string): string {
  if (given) return given
  for (const n of names) {
    const v = envOf(ctx, n)
    if (v) return v
  }
  throw new HttpError(500, `${what} is not set: pass it as an option or set ${names[0]}`, { code: 'misconfigured' })
}
const urlOf = (ctx: any, url?: string) => setting(ctx, url, ['STITCHDB_URL'], 'The project URL')
const anonOf = (ctx: any, key?: string) => setting(ctx, key, ['STITCHDB_ANON_KEY', 'STITCHDB_PUBLISHABLE_KEY'], 'The project anon key')
const serviceOf = (ctx: any, key?: string) => setting(ctx, key, ['STITCHDB_SERVICE_ROLE_KEY', 'STITCHDB_SECRET_KEY'], 'The service role key')

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') || '')
  return m ? m[1] : null
}

const serverAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
const clients = new Map<string, StitchClient<any, any, any>>()
function shared(url: string, key: string): StitchClient<any, any, any> {
  const id = `${url}\n${key}`
  let c = clients.get(id)
  if (!c) {
    c = createClient(url, key, { auth: serverAuth })
    if (clients.size > 20) clients.clear()
    clients.set(id, c)
  }
  return c
}

function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
}

// ---------- built-ins ----------

/** Adds `ctx.requestId` (the incoming `X-Request-Id` when it looks safe, else a new UUID) and echoes it on the response. */
export function withRequestId(options: { header?: string } = {}) {
  const header = options.header || 'x-request-id'
  return defineMiddleware({
    key: 'requestId',
    run: (req) => {
      const v = req.headers.get(header)
      return v && /^[\w.:-]{1,128}$/.test(v) ? v : crypto.randomUUID()
    },
    after: (res, req, ctx) => withHeaders(res, { [header]: ctx.requestId ?? null }),
  })
}

export interface CorsOptions {
  /** `'*'` (default), one origin, a list, or a function that decides. */
  origin?: string | readonly string[] | ((origin: string) => boolean)
  /** Extra request headers to allow (the ones the StitchDB SDKs send are always allowed). */
  headers?: readonly string[]
  methods?: readonly string[]
  exposeHeaders?: readonly string[]
  credentials?: boolean
  /** Seconds browsers may cache the preflight answer (default 86400). */
  maxAge?: number
}
export interface CorsInfo { origin: string | null; allowed: boolean }

/** Answers CORS preflight requests and adds CORS headers to every response (errors included). */
export function withCors(options: CorsOptions = {}) {
  const o = options.origin ?? '*'
  const allowHeaders = [corsHeaders['Access-Control-Allow-Headers'], ...(options.headers || [])].join(', ')
  const methods = (options.methods || corsHeaders['Access-Control-Allow-Methods'].split(', ')).join(', ')
  const matches = (origin: string) => (typeof o === 'function' ? o(origin) : typeof o === 'string' ? o === '*' || o === origin : o.includes(origin))
  const headersFor = (origin: string | null): Record<string, string> => {
    const any = o === '*' && !options.credentials
    if (!any && (!origin || !matches(origin))) return { Vary: 'Origin' }
    const h: Record<string, string> = { 'Access-Control-Allow-Origin': any ? '*' : origin! }
    if (!any) h.Vary = 'Origin'
    if (options.credentials) h['Access-Control-Allow-Credentials'] = 'true'
    if (options.exposeHeaders?.length) h['Access-Control-Expose-Headers'] = options.exposeHeaders.join(', ')
    return h
  }
  return defineMiddleware({
    key: 'cors',
    run: (req): CorsInfo | Response => {
      const origin = req.headers.get('origin')
      const h = headersFor(origin)
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { ...h, ...('Access-Control-Allow-Origin' in h ? {
          'Access-Control-Allow-Headers': allowHeaders, 'Access-Control-Allow-Methods': methods, 'Access-Control-Max-Age': String(options.maxAge ?? 86400) } : {}) } })
      }
      return { origin, allowed: 'Access-Control-Allow-Origin' in h }
    },
    after: (res, req) => withHeaders(res, headersFor(req.headers.get('origin'))),
  })
}

export interface ClaimsOptions {
  /** Project URL (default `STITCHDB_URL`). */
  url?: string
  /** Anon or publishable key (default `STITCHDB_ANON_KEY`). */
  key?: string
  /** Service role key, recognised as the `service_role` caller (default `STITCHDB_SERVICE_ROLE_KEY`, optional). */
  serviceKey?: string
  /** A JSON Web Key Set to verify against instead of fetching the project's. */
  jwks?: { keys: any[] }
}

/**
 * Verifies the caller's `Authorization: Bearer` token and adds `ctx.claims`: the claims for a signed-in user (or the
 * service role), `null` for anonymous callers (no token, or the anon key). An invalid or expired token answers 401.
 */
export function withClaims(options: ClaimsOptions = {}) {
  return defineMiddleware({
    key: 'claims',
    run: async (req, ctx): Promise<Claims | null | Response> => {
      const token = bearerToken(req)
      if (!token) return null
      const anon = anonOf(ctx, options.key)
      if (token === anon) return null
      const service = options.serviceKey || envOf(ctx, 'STITCHDB_SERVICE_ROLE_KEY')
      if (service && token === service) return { ...(decodePayload(token) || {}), role: 'service_role' } as Claims
      const { data, error } = await shared(urlOf(ctx, options.url), anon).auth.getClaims(token, options.jwks ? { jwks: options.jwks } : {})
      if (error || !data) return errorResponse(401, error?.message || 'Invalid token', 'invalid_token')
      const claims = data.claims as Claims
      return claims.role === 'anon' ? null : claims
    },
  })
}

/**
 * Requires a signed-in caller (401 otherwise). With a check, also requires a role or a predicate (403 otherwise).
 * Put it after {@link withClaims}.
 */
export function withRequiredClaims(check?: { role?: string | readonly string[] } | ((claims: Claims) => boolean)) {
  return defineMiddleware({
    key: 'requiredClaims',
    requires: ['claims'],
    run: (req, ctx): Claims | Response => {
      const c = ctx.claims
      if (!c) return errorResponse(401, 'Sign in required', 'unauthorized')
      if (typeof check === 'function') {
        if (!check(c)) return errorResponse(403, 'Not allowed', 'forbidden')
      } else if (check?.role != null) {
        const roles = typeof check.role === 'string' ? [check.role] : check.role
        if (!roles.includes(String(c.role))) return errorResponse(403, 'Not allowed', 'forbidden')
      }
      return c
    },
  })
}

/**
 * Adds `ctx.stitch`: a client that acts as the caller (their token, or anon), so Row Level Security applies.
 */
export function withStitchClient(options: { url?: string; key?: string } = {}) {
  return defineMiddleware({
    key: 'stitch',
    run: (req, ctx) => {
      const url = urlOf(ctx, options.url), key = anonOf(ctx, options.key)
      const token = bearerToken(req)
      const headers: Record<string, string> = token && token !== key ? { Authorization: `Bearer ${token}` } : {}
      return createClient(url, key, { auth: serverAuth, global: { headers } })
    },
  })
}

/** Adds `ctx.stitchAdmin`: a service-role client that bypasses Row Level Security. Server-side only. */
export function withStitchAdminClient(options: { url?: string; key?: string } = {}) {
  return defineMiddleware({
    key: 'stitchAdmin',
    run: (req, ctx) => shared(urlOf(ctx, options.url), serviceOf(ctx, options.key)),
  })
}

/** A `postgres` (postgres.js) instance, or anything with the same `begin` and tagged-template API. */
export interface PostgresSql {
  begin<T>(fn: (tx: any) => T | Promise<T>): Promise<T>
  (strings: TemplateStringsArray, ...values: any[]): any
}
export interface PgUserClient {
  /** Runs `fn` in a transaction as the caller (role and JWT claims set like the REST API does), so RLS applies. */
  transaction<T>(fn: (tx: any) => T | Promise<T>): Promise<T>
}

const SAFE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Adds `ctx.pg`: Postgres queries as the caller, in a transaction with their role and claims set, so RLS applies.
 * Pass your postgres.js instance, e.g. `postgres(Deno.env.get('STITCHDB_DB_URL')!, { prepare: false })`.
 * Put it after {@link withClaims}. On Cloudflare Workers use the REST client (`withStitchClient`) instead.
 */
export function withPostgresClient(options: { sql: PostgresSql }) {
  if (!options?.sql) throw new TypeError('withPostgresClient: pass { sql } (a postgres.js instance)')
  const sql = options.sql
  return defineMiddleware({
    key: 'pg',
    requires: ['claims'],
    run: (req, ctx): PgUserClient => {
      const claims: Claims = ctx.claims || ({ role: 'anon' } as Claims)
      const role = String(claims.role || 'anon')
      if (!SAFE_ROLE.test(role)) throw new HttpError(403, 'Not allowed', { code: 'forbidden' })
      return {
        transaction: (fn) => sql.begin(async (tx: any) => {
          await tx`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
            set_config('request.jwt.claim.sub', ${String(claims.sub ?? '')}, true), set_config('request.jwt.claim.role', ${role}, true)`
          return fn(tx)
        }),
      }
    },
  })
}

/** Adds `ctx.pgAdmin`: your postgres.js instance as is (the database owner; RLS does not apply). Server-side only. */
export function withPostgresAdminClient(options: { sql: PostgresSql }) {
  if (!options?.sql) throw new TypeError('withPostgresAdminClient: pass { sql } (a postgres.js instance)')
  return defineMiddleware({ key: 'pgAdmin', run: () => options.sql })
}

export interface ProtectedResourceOptions {
  /** The public URL of this API (e.g. `https://<project-ref>.p.stitchdb.com/functions/v1/mcp`). */
  resource: string
  /** Authorization servers (default: the project's Auth, `<STITCHDB_URL>/auth/v1`). */
  authorizationServers?: readonly string[]
  scopes?: readonly string[]
  resourceName?: string
}

/**
 * OAuth protected resource metadata (RFC 9728) for MCP servers and other OAuth clients: answers
 * `GET <resource>/.well-known/oauth-protected-resource` and adds a `WWW-Authenticate` challenge pointing to it on every
 * 401. Put it before {@link withClaims}.
 */
export function withOAuthProtectedResource(options: ProtectedResourceOptions) {
  if (!options?.resource) throw new TypeError('withOAuthProtectedResource: resource (the public URL of this API) is required')
  const resource = options.resource.replace(/\/+$/, '')
  const metadataUrl = `${resource}/.well-known/oauth-protected-resource`
  const metadataPath = new URL(metadataUrl).pathname
  return defineMiddleware({
    key: 'oauthResource',
    run: (req, ctx) => {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && (path === metadataPath || path.endsWith('/.well-known/oauth-protected-resource'))) {
        const servers = options.authorizationServers || [`${urlOf(ctx, undefined).replace(/\/+$/, '')}/auth/v1`]
        return Response.json({
          resource, authorization_servers: servers, bearer_methods_supported: ['header'],
          ...(options.scopes ? { scopes_supported: options.scopes } : {}), ...(options.resourceName ? { resource_name: options.resourceName } : {}),
        }, { headers: { 'Cache-Control': 'public, max-age=3600' } })
      }
      return { resource, metadataUrl }
    },
    after: (res) => {
      if (res.status !== 401 || res.headers.has('www-authenticate')) return
      return withHeaders(res, { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` })
    },
  })
}

export interface RateLimitStore {
  /** Counts one request for `key` in the current window. */
  hit(key: string, windowMs: number): { count: number; resetAt: number } | Promise<{ count: number; resetAt: number }>
}
export interface RateLimitInfo { limit: number; remaining: number; resetAt: number }

/** Fixed-window counts in this instance's memory. Each instance (and each cold start) counts on its own. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  constructor(private readonly maxKeys = 10_000) {}
  hit(key: string, windowMs: number) {
    const now = Date.now()
    let w = this.windows.get(key)
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) {
        for (const [k, v] of this.windows) if (v.resetAt <= now) this.windows.delete(k)
        if (this.windows.size >= this.maxKeys) this.windows.clear()
      }
      w = { count: 0, resetAt: now + windowMs }
      this.windows.set(key, w)
    }
    w.count++
    return { count: w.count, resetAt: w.resetAt }
  }
}

function clientIp(req: Request): string {
  const f = req.headers.get('x-forwarded-for')
  return (f ? f.split(',')[0] : req.headers.get('x-real-ip') || 'unknown').trim()
}

/**
 * Limits requests per caller: `limit` requests per `windowMs` (default one minute), 429 with `Retry-After` above it.
 * The default key is the signed-in user (when {@link withClaims} ran earlier) or the client IP. The default store
 * counts per instance; pass a shared `store` to count across instances.
 */
export function withRateLimit(options: { limit: number; windowMs?: number; key?: (req: Request, ctx: any) => string; store?: RateLimitStore }) {
  const limit = Math.floor(Number(options?.limit))
  if (!(limit > 0)) throw new TypeError('withRateLimit: limit must be a positive number')
  const windowMs = Math.max(1000, Number(options.windowMs) || 60_000)
  const store = options.store || new MemoryRateLimitStore()
  const keyOf = options.key || ((req: Request, ctx: any) => (ctx.claims?.sub ? `user:${ctx.claims.sub}` : `ip:${clientIp(req)}`))
  const headersOf = (i: RateLimitInfo) => ({
    'RateLimit-Limit': String(i.limit), 'RateLimit-Remaining': String(i.remaining), 'RateLimit-Reset': String(Math.max(0, Math.ceil((i.resetAt - Date.now()) / 1000))),
  })
  return defineMiddleware({
    key: 'rateLimit',
    run: async (req, ctx): Promise<RateLimitInfo | Response> => {
      const { count, resetAt } = await store.hit(keyOf(req, ctx), windowMs)
      const info = { limit, remaining: Math.max(0, limit - count), resetAt }
      if (count > limit) {
        const retry = String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)))
        return errorResponse(429, 'Too many requests', 'rate_limited', { ...headersOf(info), 'Retry-After': retry })
      }
      return info
    },
    after: (res, req, ctx) => (ctx.rateLimit ? withHeaders(res, headersOf(ctx.rateLimit)) : undefined),
  })
}

// ---------- Node ----------

/**
 * Turns a fetch handler into a `node:http` request listener (Node 18+):
 * `http.createServer(toNodeHandler(handler)).listen(3000)`.
 */
export function toNodeHandler(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: any, res: any) => {
    try {
      const host = req.headers.host || 'localhost'
      const proto = req.socket?.encrypted ? 'https' : 'http'
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers as Record<string, string | string[] | undefined>)) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, x)
        else if (v != null) headers.set(k, v)
      }
      let body: Uint8Array | undefined
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Uint8Array[] = []
        for await (const c of req) chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : c)
        let n = 0
        for (const c of chunks) n += c.length
        body = new Uint8Array(n)
        let o = 0
        for (const c of chunks) { body.set(c, o); o += c.length }
      }
      const out = await handler(new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body }))
      const h: Record<string, string | string[]> = {}
      out.headers.forEach((v, k) => { h[k] = v })
      const cookies = (out.headers as any).getSetCookie?.()
      if (cookies?.length) h['set-cookie'] = cookies
      res.writeHead(out.status, out.statusText || undefined, h)
      if (out.body && req.method !== 'HEAD') {
        const reader = out.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    } catch (e) {
      console.error('[stitchdb middleware] node bridge error:', e)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'internal_error', message: 'Internal error' }))
    }
  }
}
