/**
 * Job monitoring (set up in Studio): alerts when a scheduled job did not run, failed or ran too long. A ping
 * monitor watches an outside cron job, script or worker that calls its secret ping URL when it runs; pg_cron jobs and
 * background jobs are watched without any code. With the service key you can also read the monitors and their runs.
 *
 * @example
 * ```ts
 * // a worker or cron script: the token (hb_…) is the secret, no API key needed
 * await stitchdb.heartbeat.run(process.env.NIGHTLY_MONITOR, async () => { await exportOrders() })
 *
 * // or by hand
 * await stitchdb.heartbeat.ping(token, { status: 'start' })
 * await stitchdb.heartbeat.ping(token, { exitCode: 1, message: 'disk full' })
 *
 * // server side, with the service key
 * const { data } = await admin.heartbeat.monitors()
 * ```
 *
 * @module heartbeat
 */
import type { Fetch } from './lib/types'

export class HeartbeatError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'HeartbeatError' }
}
type Result<T> = { data: T; error: null } | { data: null; error: HeartbeatError }

export type PingOptions = {
  /** 'ok' (default): the run worked; 'start': it started (for the run time and "runs too long"); 'fail': it failed. */
  status?: 'ok' | 'start' | 'fail'
  /** An exit code instead of a status: 0 worked, anything else failed. */
  exitCode?: number
  /** Stored with the run (the first 2 KB), for example the end of the log or the error. */
  message?: string
}
export type Monitor = {
  id: number; name: string; kind: 'ping' | 'cron' | 'job'
  /** pg_cron job name or background job name (cron and job monitors). */
  target: string | null
  schedule: string | null; period_s: number | null; tz: string; grace_s: number; max_runtime_s: number | null
  paused: boolean; state: 'new' | 'up' | 'down' | 'failed' | 'paused'
  last_run_at: string | null; last_ok_at: string | null; last_status: string | null; last_message: string | null; last_duration_ms: number | null
  next_due: string | null; down_since: string | null; running_since: string | null; created_at: string
  /** Ping monitors: the secret ping token. */
  token?: string
}
export type MonitorRun = {
  id: number; status: 'running' | 'ok' | 'failed' | 'missed'; source: string
  started_at: string; ended_at: string | null; duration_ms: number | null; message: string | null
}

const TOKEN_RE = /^hb_[A-Za-z0-9]{24}$/

export class HeartbeatClient {
  constructor(private url: string, private fetch: Fetch) {}
  private async req<T>(method: string, path: string, body?: string): Promise<Result<T>> {
    try {
      const res = await this.fetch(this.url + path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new HeartbeatError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j as T, error: null }
    } catch (e: any) { return { data: null, error: new HeartbeatError(e?.message || String(e), 0) } }
  }

  /** The token of a ping URL (`https://…/heartbeat/v1/hb_…`), or the token itself; null for anything else. */
  static tokenFrom(urlOrToken: string): string | null {
    const s = String(urlOrToken || '').trim()
    if (TOKEN_RE.test(s)) return s
    const m = /\/heartbeat\/v1\/(hb_[A-Za-z0-9]{24})(?:\/|$|\?)/.exec(s)
    return m ? m[1] : null
  }

  /** The ping URL for a monitor, for curl in a crontab: `curl -fsS "$(…)"`, `…/start`, `…/fail` or `…/<exit code>`. */
  pingUrl(token: string, options: Omit<PingOptions, 'message'> = {}): string {
    const t = HeartbeatClient.tokenFrom(token)
    if (!t) throw new HeartbeatError('Not a ping token (hb_ and 24 letters or digits) or ping URL', 0)
    return `${this.url}/${t}${HeartbeatClient.suffix(options)}`
  }
  private static suffix(o: Omit<PingOptions, 'message'>): string {
    if (o.exitCode != null) {
      if (!Number.isInteger(o.exitCode) || o.exitCode < 0 || o.exitCode > 255) throw new HeartbeatError('exitCode: 0 to 255', 0)
      return `/${o.exitCode}`
    }
    return o.status === 'start' ? '/start' : o.status === 'fail' ? '/fail' : ''
  }

  /**
   * Tell the monitor the job ran (or started, or failed). No API key is needed: the token is the secret. At most 30
   * calls a minute per monitor; a paused monitor answers `{ ok: true, paused: true }`.
   */
  async ping(token: string, options: PingOptions = {}): Promise<Result<{ ok: true; started?: true; paused?: true }>> {
    let url: string
    try { url = this.pingUrl(token, options) } catch (e: any) { return { data: null, error: e } }
    return this.req('POST', url.slice(this.url.length), options.message == null ? '' : String(options.message).slice(0, 2000))
  }

  /**
   * Run a job between a start and an end ping: `ok` when `fn` resolves, `fail` with the error message when it throws
   * (the error is thrown again). A failing ping never fails the job.
   */
  async run<T>(token: string, fn: () => T | Promise<T>): Promise<T> {
    await this.ping(token, { status: 'start' })
    try {
      const out = await fn()
      await this.ping(token)
      return out
    } catch (e: any) {
      await this.ping(token, { status: 'fail', message: String(e?.stack || e?.message || e) })
      throw e
    }
  }

  /** Every monitor with its state (service key). */
  async monitors(): Promise<Result<Monitor[]>> {
    const r = await this.req<{ monitors: Monitor[] }>('GET', '/monitors')
    return r.error ? r : { data: r.data.monitors, error: null }
  }
  /** One monitor with its latest runs, newest first (default 100, at most 500; service key). */
  monitor(id: number, options: { limit?: number } = {}): Promise<Result<{ monitor: Monitor; runs: MonitorRun[] }>> {
    return this.req('GET', `/monitors/${encodeURIComponent(String(id))}${options.limit ? `?limit=${options.limit}` : ''}`)
  }
}
