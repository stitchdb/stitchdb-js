/**
 * Durable background jobs: multi-step jobs that survive crashes and deploys, retry failing steps and sleep for
 * minutes to days. A job is an Edge Function whose handler is wrapped in {@link job}; StitchDB stores the result of
 * every finished step and calls the function again for the next one.
 *
 * @example
 * ```ts
 * import { job } from 'https://stitchdb.com/sdk/stitchdb-jobs.mjs'   // or 'stitchdb-js/jobs'
 *
 * Deno.serve(job(async (payload, ctx) => {
 *   const user = await ctx.step('load user', () => loadUser(payload.user_id))
 *   await ctx.step('welcome e-mail', () => sendWelcome(user.email))
 *   await ctx.sleep('wait a day', '1d')
 *   await ctx.step('tips e-mail', () => sendTips(user.email))
 *   return { sent: 2 }
 * }))
 * ```
 *
 * Start a run from your server with `stitchdb.jobs.start('onboarding', { user_id })` (service key), from SQL with
 * `select stitch_jobs_enqueue('onboarding', jsonb_build_object('user_id', id))`, or in Studio.
 *
 * Job mode: for light, mostly-waiting work that needs one long call (imports, batch e-mails, AI calls over many
 * documents, syncs with other APIs), wrap the handler in {@link longJob} and start it with `{ mode: 'long' }`. It runs
 * for up to the plan's job-mode minutes (15 on Pro, 60 on Scale) with a small CPU allowance, and reports progress,
 * logs and checkpoints. Heavy CPU work (video encoding, image processing) is not supported.
 *
 * ```ts
 * import { longJob } from 'https://stitchdb.com/sdk/stitchdb-jobs.mjs'
 *
 * Deno.serve(longJob(async (payload, ctx) => {
 *   const rows = await loadCsv(payload.url)
 *   let i = ctx.checkpoint?.next ?? 0              // continue after a restart
 *   for (; i < rows.length; i++) {
 *     await importRow(rows[i])
 *     ctx.progress((i + 1) / rows.length, `${i + 1} of ${rows.length} rows`)
 *     if (i % 500 === 0) ctx.save({ next: i + 1 })
 *   }
 *   ctx.log('import finished')
 *   return { imported: rows.length }
 * }))
 * ```
 *
 * @module jobs
 */
import type { Fetch } from './lib/types'

// ---------- inside the job (Edge Function) ----------

export type JobRun = { id: string; job: string; attempt: number; created_at: string }

export type StepOptions = {
  /** Attempts for this step before the run fails (default: the run's max_attempts, 5). */
  maxAttempts?: number
}

export interface JobContext {
  /** The run: its id, the job name, the attempt of the current step (1, 2, …) and when it was started. */
  run: JobRun
  /**
   * Run `fn` once and remember its result. When the job continues later (after the next step, a sleep, a retry or a
   * crash), the stored result is returned instead of running `fn` again. Names must be unique within a run.
   * The result must be JSON (at most 256 KB); return ids, not large data.
   */
  step<T>(name: string, fn: () => T | Promise<T>, options?: StepOptions): Promise<T>
  /** Pause the run for a duration: milliseconds or `'30s'`, `'15m'`, `'2h'`, `'7d'` (up to a year). */
  sleep(name: string, duration: number | string): Promise<void>
  /** Pause the run until a time. */
  sleepUntil(name: string, until: Date | string | number): Promise<void>
}

/** Throw this from a step to fail the run at once, without retrying (e.g. invalid input). */
export class FatalJobError extends Error {
  constructor(message: string) { super(message); this.name = 'FatalJobError' }
}

type Op = { op: 'step'; name: string; output: unknown } | { op: 'sleep'; name: string; until: string } | { op: 'done'; result: unknown }
  | { op: 'error'; name: string | null; message: string; retry: boolean; max_attempts?: number }

class Yield { constructor(readonly op: Op) {} }

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }
/** `'90s'`, `'15m'`, `'2h'`, `'1d'`, `'1w'` or milliseconds → milliseconds. */
export function parseDuration(d: number | string): number {
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) return d
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(String(d))
  if (!m) throw new FatalJobError(`Not a duration: ${d} (use e.g. '30s', '15m', '2h' or '1d')`)
  return Number(m[1]) * UNITS[m[2].toLowerCase()]
}

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
const env = (k: string): string | undefined => {
  const g = globalThis as any
  return g.Deno?.env?.get?.(k) ?? g.process?.env?.[k]
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Check the signature of a call from the StitchDB job worker (the service key signs every call). */
export async function verifyJobRequest(header: string | null, body: string, serviceKey: string, now = Date.now()): Promise<boolean> {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || '')
  if (!m || !serviceKey) return false
  if (Math.abs(now / 1000 - Number(m[1])) > 300) return false
  return same(await hmac(serviceKey, `${m[1]}.${body}`), m[2])
}

export type JobHandler<P = any, R = unknown> = (payload: P, ctx: JobContext) => R | Promise<R>

/**
 * Make an Edge Function a durable job. Returns a `(request) => Response` handler for `Deno.serve`.
 * Only the StitchDB job worker can call it (requests are signed with the project's service key).
 * Code outside `ctx.step` runs again every time the job continues, so keep side effects inside steps.
 */
export function job<P = any, R = unknown>(handler: JobHandler<P, R>, options: { serviceKey?: string } = {}): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const key = options.serviceKey || env('STITCHDB_SERVICE_ROLE_KEY') || ''
    const raw = await req.text()
    if (!(await verifyJobRequest(req.headers.get('x-stitchdb-job'), raw, key)))
      return json({ message: 'This function is a background job: start it with stitchdb.jobs.start(), stitch_jobs_enqueue() or in Studio' }, 401)
    const { run, payload, steps = {} } = JSON.parse(raw) as { run: JobRun; payload: P; steps: Record<string, { output: unknown }> }
    return json(await execute(handler, run, payload, steps))
  }
}

/** Run the handler against the stored steps and return the next operation (exported for tests). */
export async function execute<P, R>(handler: JobHandler<P, R>, run: JobRun, payload: P, steps: Record<string, { output: unknown }>): Promise<Op> {
  const seen = new Set<string>()
  const name = (n: string) => {
    const s = String(n ?? '').trim()
    if (!s) throw new FatalJobError('Every step needs a name')
    if (seen.has(s)) throw new FatalJobError(`Two steps are called "${s}"; step names must be unique within a run`)
    seen.add(s)
    return s
  }
  const ctx: JobContext = {
    run,
    async step(n, fn, opts = {}) {
      const s = name(n)
      if (Object.prototype.hasOwnProperty.call(steps, s)) return steps[s].output as any
      let output: unknown
      try { output = await fn() } catch (e: any) {
        if (e instanceof Yield) throw e
        throw new Yield({ op: 'error', name: s, message: e?.message || String(e), retry: !(e instanceof FatalJobError), ...(opts.maxAttempts ? { max_attempts: opts.maxAttempts } : {}) })
      }
      throw new Yield({ op: 'step', name: s, output: output === undefined ? null : output })
    },
    async sleep(n, d) { return ctx.sleepUntil(n, Date.now() + parseDuration(d)) },
    async sleepUntil(n, until) {
      const s = name(n)
      if (Object.prototype.hasOwnProperty.call(steps, s)) return
      const t = new Date(until)
      if (Number.isNaN(t.getTime())) throw new FatalJobError(`Sleep "${s}": not a time`)
      throw new Yield({ op: 'sleep', name: s, until: t.toISOString() })
    },
  }
  try {
    const result = await handler(payload, ctx)
    return { op: 'done', result: result === undefined ? null : result }
  } catch (e: any) {
    if (e instanceof Yield) return e.op
    return { op: 'error', name: null, message: e?.message || String(e), retry: !(e instanceof FatalJobError) }
  }
}

// ---------- job mode (one long run) ----------

export interface LongJobContext<C = any> {
  /** The run: its id, the job name, the attempt (1, 2, … after a restart) and when it was started. */
  run: JobRun & { mode: 'long' }
  /** The last data passed to {@link LongJobContext.save} in an earlier attempt, or null. */
  checkpoint: C | null
  /** Report progress: a fraction 0 to 1 and an optional message (shown in Studio and in the run). */
  progress(value: number, message?: string): void
  /** Add a line to the run's log (at most 5,000 lines per run). */
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /** Save a checkpoint (JSON, at most 256 KB): if the run is interrupted, the next attempt gets it as `ctx.checkpoint`. */
  save(data: C): void
  /** Aborted when the run is cancelled or stopped: pass it to fetch() and check it in loops. */
  signal: AbortSignal
}
export type LongJobHandler<P = any, R = unknown> = (payload: P, ctx: LongJobContext) => R | Promise<R>

const text = (args: unknown[]) => args.map((a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()).join(' ')

/**
 * Make an Edge Function a long job (job mode). Returns a `(request) => Response` handler for `Deno.serve`.
 * Only the StitchDB job worker can call it. Start runs with `stitchdb.jobs.start(name, payload, { mode: 'long' })`.
 * Throw {@link FatalJobError} to fail without another attempt.
 */
export function longJob<P = any, R = unknown>(handler: LongJobHandler<P, R>, options: { serviceKey?: string } = {}): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const key = options.serviceKey || env('STITCHDB_SERVICE_ROLE_KEY') || ''
    const raw = await req.text()
    if (!(await verifyJobRequest(req.headers.get('x-stitchdb-job'), raw, key)))
      return json({ message: 'This function is a long job: start it with stitchdb.jobs.start(name, payload, { mode: \'long\' }), stitch_jobs_enqueue_long() or in Studio' }, 401)
    const { run, payload, checkpoint = null } = JSON.parse(raw) as { run: JobRun & { mode: 'long' }; payload: P; checkpoint: unknown }
    const stream = runLong(handler, run, payload, checkpoint, req.signal)
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } })
  }
}

/** Run a long job and return its stream of JSON lines (exported for tests). */
export function runLong<P, R>(handler: LongJobHandler<P, R>, run: JobRun & { mode: 'long' }, payload: P, checkpoint: unknown, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const ac = new AbortController()
  signal?.addEventListener('abort', () => ac.abort(signal.reason), { once: true })
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  let open = true
  const send = (e: Record<string, unknown>) => { if (open) { try { ctrl.enqueue(enc.encode(JSON.stringify(e) + '\n')) } catch { open = false } } }
  let lastProgress = 0, pendingProgress: Record<string, unknown> | null = null, timer: ReturnType<typeof setTimeout> | null = null
  const ctx: LongJobContext = {
    run, checkpoint: checkpoint ?? null, signal: ac.signal,
    progress(value, message) {
      // at most a few updates a second: loops can call this for every item
      pendingProgress = { t: 'progress', value: Number(value), ...(message != null ? { message: String(message) } : {}) }
      const wait = 250 - (Date.now() - lastProgress)
      if (wait <= 0) { lastProgress = Date.now(); send(pendingProgress); pendingProgress = null }
      else if (!timer) timer = setTimeout(() => { timer = null; if (pendingProgress) { lastProgress = Date.now(); send(pendingProgress); pendingProgress = null } }, wait)
    },
    log: (...a) => send({ t: 'log', level: 'info', msg: text(a) }),
    warn: (...a) => send({ t: 'log', level: 'warn', msg: text(a) }),
    error: (...a) => send({ t: 'log', level: 'error', msg: text(a) }),
    save: (data) => send({ t: 'checkpoint', data: data === undefined ? null : data }),
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
      const ping = setInterval(() => send({ t: 'ping' }), 15000)
      ;(async () => {
        try {
          // let the response start first: a handler that blocks right away still streams its events
          await new Promise((r) => setTimeout(r, 0))
          const result = await handler(payload, ctx)
          if (pendingProgress) send(pendingProgress)
          send({ t: 'done', result: result === undefined ? null : result })
        } catch (e: any) {
          if (pendingProgress) send(pendingProgress)
          send({ t: 'error', message: e?.message || String(e), retry: !(e instanceof FatalJobError) })
        } finally {
          clearInterval(ping); if (timer) clearTimeout(timer)
          if (open) { open = false; try { c.close() } catch {} }
        }
      })()
    },
    cancel() { open = false; ac.abort(new Error('The run was stopped')) },
  })
}

// ---------- starting and watching runs (server side, with the service key) ----------

export type JobStatus = 'queued' | 'running' | 'sleeping' | 'completed' | 'failed' | 'cancelled'
export type JobRunInfo<P = any, R = any> = {
  id: string; job: string; mode: 'steps' | 'long'; status: JobStatus; payload: P; result: R | null; error: string | null; attempt: number; max_attempts: number
  idempotency_key: string | null; run_at: string; created_at: string; started_at: string | null; finished_at: string | null
  steps?: { name: string; kind: 'step' | 'sleep'; status: string; output: unknown; error: string | null; attempts: number; wake_at: string | null }[]
  /** Long runs (job mode): progress 0 to 1, the last progress message, billed seconds and the last checkpoint. */
  progress?: number | null; message?: string | null; seconds?: number; checkpoint?: unknown
}
export type JobLogLine = { seq: number; at: string; level: 'info' | 'warn' | 'error' | 'debug'; line: string }
export type StartOptions = {
  /** The same job and key start one run only; a repeat returns the first run with `duplicate: true`. */
  idempotencyKey?: string
  /** Start after this many seconds, or at `runAt`. */
  delay?: number
  runAt?: Date | string
  /** Attempts per step before the run fails (default 5; for long runs, attempts after an interruption, default 1). */
  maxAttempts?: number
  /** `'long'`: job mode, one long call to a function wrapped in {@link longJob}. */
  mode?: 'steps' | 'long'
}
type Result<T> = { data: T; error: null } | { data: null; error: JobsError }

export class JobsError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.name = 'JobsError'; this.status = status }
}

/** `stitchdb.jobs`: start, list, cancel and retry background job runs. Needs a client made with the service key. */
export class JobsClient {
  constructor(private url: string, private fetch: Fetch) {}
  private async req<T>(path: string, init?: { method?: string; body?: unknown }): Promise<Result<T>> {
    try {
      const res = await this.fetch(this.url + path, init?.body === undefined ? { method: init?.method || 'GET' } : { method: init.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new JobsError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j as T, error: null }
    } catch (e: any) { return { data: null, error: new JobsError(e?.message || String(e), 0) } }
  }
  /** Start a run of the job (the Edge Function with this name). */
  start<P = any>(job: string, payload?: P, options: StartOptions = {}): Promise<Result<JobRunInfo<P> & { duplicate: boolean }>> {
    return this.req('/runs', { body: { job, payload: payload ?? {}, idempotency_key: options.idempotencyKey, delay: options.delay,
      run_at: options.runAt instanceof Date ? options.runAt.toISOString() : options.runAt, max_attempts: options.maxAttempts, mode: options.mode } })
  }
  /** A long run's log lines after `after` (the `next` of the previous call), oldest first. */
  logs(id: string, options: { after?: number; limit?: number } = {}): Promise<Result<{ lines: JobLogLine[]; next: number; more: boolean }>> {
    const q = new URLSearchParams(Object.entries(options).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    return this.req(`/runs/${encodeURIComponent(id)}/logs${q.size ? `?${q}` : ''}`)
  }
  /** A run with its steps. */
  get(id: string): Promise<Result<JobRunInfo>> { return this.req(`/runs/${encodeURIComponent(id)}`) }
  /** Recent runs, newest first. */
  async list(filter: { job?: string; status?: JobStatus; limit?: number; before?: string } = {}): Promise<Result<JobRunInfo[]>> {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    const r = await this.req<{ runs: JobRunInfo[] }>(`/runs${q.size ? `?${q}` : ''}`)
    return r.error ? r : { data: r.data.runs, error: null }
  }
  /** Stop a queued, running or sleeping run. A step that is running finishes, but its result is not used. */
  cancel(id: string): Promise<Result<JobRunInfo>> { return this.req(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }) }
  /** Run a failed or cancelled run again from the step that failed (finished steps are kept). */
  retry(id: string): Promise<Result<JobRunInfo>> { return this.req(`/runs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }) }
}
