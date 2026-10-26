/**
 * Crash and error reporting: uncaught errors and unhandled promise rejections (browsers and Node), and errors you
 * report yourself, grouped into issues in Studio › Crashes with the stack, app version, device, the signed-in user and
 * the user's last actions and API calls ("crashed right after GET /rest/v1/orders returned 500").
 *
 * @example
 * ```ts
 * stitchdb.crashes.start({ release: '1.4.0' })
 * try { await checkout() } catch (e) { stitchdb.crashes.captureException(e, { context: { step: 'payment' } }) }
 * stitchdb.crashes.addBreadcrumb({ type: 'ui', message: 'tapped Checkout' })
 * ```
 *
 * Nothing is sent until you call `start()` and the project has crash reporting turned on (Studio › Crashes). Ask for
 * consent first where you need it, or decide per report in `beforeSend`. Passwords, tokens, keys and e-mail addresses
 * are removed by StitchDB before anything is stored. Reports that cannot be sent (offline, the page closing) are kept
 * (in localStorage in browsers) and sent on the next start.
 *
 * @module crashes
 */
import type { Fetch } from './lib/types'
import { version } from './lib/version'

export type Breadcrumb = {
  /** api, navigation, ui, log or your own word. */
  type?: string
  message?: string
  level?: 'debug' | 'info' | 'warning' | 'error'
  data?: Record<string, unknown>
  at?: string
}

export type CrashReport = {
  platform: string
  release: string | null
  environment: string
  install_id: string
  at: string
  handled: boolean
  exception: { type: string; message: string; stack?: string; mechanism?: string }
  breadcrumbs: Breadcrumb[]
  device: Record<string, unknown>
  context: Record<string, unknown>
  fingerprint?: string[]
}

export type CrashesOptions = {
  /** Your app's version, e.g. '1.4.0' or a build number: issues and crash-free users are shown per release. */
  release?: string
  /** Default 'production'. */
  environment?: string
  /** Catch uncaught errors and unhandled rejections (default true). In Node the process still exits after a crash. */
  captureUnhandled?: boolean
  /** Change a report or return null to not send it (consent, filtering). */
  beforeSend?: (report: CrashReport) => CrashReport | null | Promise<CrashReport | null>
  /** Breadcrumbs kept (default 50, at most 100). */
  maxBreadcrumbs?: number
}

const MAX_QUEUE = 30
const store = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null } }
const read = (k: string) => { try { const v = store()?.getItem(k); return v ? JSON.parse(v) : null } catch { return null } }
const write = (k: string, v: unknown) => { try { if (v == null) store()?.removeItem(k); else store()?.setItem(k, JSON.stringify(v)) } catch { /* private mode, quota */ } }
const g: any = typeof globalThis !== 'undefined' ? globalThis : {}
const isNode = typeof g.process !== 'undefined' && !!g.process.versions?.node && typeof g.window === 'undefined'
const randomId = () => { try { return g.crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` } }

/** The API calls the SDK makes, as breadcrumbs (method, path, status, error code; no bodies, no query values). */
export type ApiCallSink = (crumb: Breadcrumb) => void
let sinks: ApiCallSink[] = []
export function recordingFetch(base: Fetch): Fetch {
  return async (input: any, init?: any) => {
    if (!sinks.length) return base(input, init)
    const t0 = Date.now()
    const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
    let url = ''
    try { const u = new URL(typeof input === 'string' ? input : input?.url || String(input)); url = u.pathname + (u.search ? '?' + [...u.searchParams.keys()].join('&') : '') } catch { /* not a URL */ }
    if (url.includes('/crashes/v1/') || url.includes('/analytics/v1/')) return base(input, init) // our own reporting calls
    try {
      const res = await base(input, init)
      let code: string | undefined
      if (res.status >= 400) {
        try { const j = await res.clone().json(); code = j?.code ?? j?.error_code ?? j?.error } catch { /* not JSON */ }
      }
      for (const s of sinks) s({ type: 'api', at: new Date(t0).toISOString(), level: res.status >= 400 ? 'error' : 'info', message: `${method} ${url} ${res.status}`,
        data: { method, url, status: res.status, ...(code ? { error_code: String(code) } : {}), ms: Date.now() - t0 } })
      return res
    } catch (e: any) {
      for (const s of sinks) s({ type: 'api', at: new Date(t0).toISOString(), level: 'error', message: `${method} ${url} failed`, data: { method, url, status: 0, error: String(e?.message || e) } })
      throw e
    }
  }
}

function deviceInfo(): Record<string, unknown> {
  if (isNode) return { runtime: 'node', runtime_version: g.process.version, os: g.process.platform, arch: g.process.arch }
  const n = g.navigator || {}
  const d: Record<string, unknown> = { runtime: 'browser', user_agent: n.userAgent, locale: n.language }
  try { d.screen = `${g.screen.width}x${g.screen.height}`; d.url = g.location ? g.location.origin + g.location.pathname : undefined } catch { /* no screen */ }
  return d
}
function toError(e: unknown): { type: string; message: string; stack?: string } {
  if (e instanceof Error) return { type: e.name || 'Error', message: e.message || '', stack: e.stack }
  if (e && typeof e === 'object') { const o: any = e; return { type: o.name || 'Error', message: String(o.message ?? JSON.stringify(o)).slice(0, 2000), stack: o.stack } }
  return { type: 'Error', message: String(e) }
}

export class CrashesClient {
  private opts: CrashesOptions = {}
  private started = false
  private crumbs: Breadcrumb[] = []
  private queue: CrashReport[] = []
  private sending: Promise<void> | null = null
  private installId: string
  private off: Array<() => void> = []
  private disabled = false

  constructor(private url: string, private fetch: Fetch, private storageKey: string) {
    this.installId = (read(`${storageKey}-install`) as string) || randomId()
    write(`${storageKey}-install`, this.installId)
  }

  /** Start reporting: catches uncaught errors (unless captureUnhandled is false), sends reports kept from earlier runs. */
  start(options: CrashesOptions = {}): this {
    this.opts = { captureUnhandled: true, environment: 'production', maxBreadcrumbs: 50, ...options }
    if (this.started) return this
    this.started = true
    this.disabled = false
    const sink: ApiCallSink = (c) => this.addBreadcrumb(c)
    sinks.push(sink)
    this.off.push(() => { sinks = sinks.filter((s) => s !== sink) })
    if (this.opts.captureUnhandled) this.hook()
    const saved = read(this.storageKey)
    if (Array.isArray(saved) && saved.length) { this.queue.push(...saved.slice(-MAX_QUEUE)); write(this.storageKey, null) }
    this.session()
    void this.flush()
    return this
  }

  /** Stop reporting and remove the handlers (for example when the user withdraws consent). */
  stop(): void {
    this.started = false
    for (const f of this.off.splice(0)) f()
  }

  /** Report an error you caught. Returns once it is queued; sending happens in the background (or await flush()). */
  captureException(error: unknown, options: { context?: Record<string, unknown>; fingerprint?: string[]; handled?: boolean } = {}): void {
    if (!this.started) return
    this.enqueue(toError(error), options.handled ?? true, options.context, options.fingerprint)
  }

  /** Report a message as an error, e.g. a state that should never happen. */
  captureMessage(message: string, options: { context?: Record<string, unknown>; fingerprint?: string[] } = {}): void {
    if (!this.started) return
    this.enqueue({ type: 'Message', message, stack: new Error(message).stack?.split('\n').slice(2).join('\n') }, true, options.context, options.fingerprint)
  }

  /** Something the user did or the app went through; the last ones are sent with the next report. */
  addBreadcrumb(c: Breadcrumb): void {
    this.crumbs.push({ ...c, at: c.at || new Date().toISOString() })
    const max = Math.min(Math.max(this.opts.maxBreadcrumbs ?? 50, 0), 100)
    if (this.crumbs.length > max) this.crumbs.splice(0, this.crumbs.length - max)
  }

  /** Send what is queued now (also retried on the next start). */
  flush(): Promise<void> {
    if (this.sending) return this.sending.then(() => (this.queue.length && !this.disabled ? this.flush() : undefined)) // reports queued while sending
    this.sending = (async () => {
      await null // so `finally` below never runs before this.sending is set
      try {
        while (this.queue.length && !this.disabled) {
          const batch = this.queue.slice(0, 20)
          const res = await this.fetch(`${this.url}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: batch }), keepalive: !isNode && JSON.stringify(batch).length < 60000 } as any)
          if (res.status === 404 || res.status === 403) { this.disabled = true; this.queue = []; break } // crash reporting is off for the project
          if (!res.ok && res.status !== 400 && res.status !== 413 && res.status !== 429) throw new Error(String(res.status))
          this.queue.splice(0, batch.length)
        }
        write(this.storageKey, null)
      } catch {
        write(this.storageKey, this.queue.slice(-MAX_QUEUE)) // offline or the server is busy: next start
      } finally { this.sending = null }
    })()
    return this.sending
  }

  private enqueue(ex: { type: string; message: string; stack?: string }, handled: boolean, context?: Record<string, unknown>, fingerprint?: string[], mechanism?: string) {
    const report: CrashReport = {
      platform: isNode ? 'node' : 'javascript', release: this.opts.release ?? null, environment: this.opts.environment || 'production', install_id: this.installId,
      at: new Date().toISOString(), handled, exception: { ...ex, ...(mechanism ? { mechanism } : {}) }, breadcrumbs: [...this.crumbs],
      device: { ...deviceInfo(), sdk: `stitchdb-js/${version}` }, context: context || {}, ...(fingerprint ? { fingerprint } : {}),
    }
    const ready = (r: CrashReport | null) => {
      if (!r) return
      this.queue.push(r)
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
      write(this.storageKey, this.queue) // kept until sent, in case the page closes now
      void this.flush()
    }
    try {
      const out = this.opts.beforeSend ? this.opts.beforeSend(report) : report
      if (out && typeof (out as any).then === 'function') (out as Promise<CrashReport | null>).then(ready, () => {})
      else ready(out as CrashReport | null)
    } catch { /* a throwing beforeSend drops the report */ }
  }

  private hook() {
    if (isNode) {
      const proc = g.process
      const onCrash = (e: unknown, mechanism: string) => {
        this.enqueue(toError(e), false, undefined, undefined, mechanism)
        const done = () => proc.exit(1) // listening to uncaughtException stops Node from exiting by itself
        Promise.race([this.flush(), new Promise((r) => setTimeout(r, 2000))]).then(done, done)
      }
      const ue = (e: unknown) => onCrash(e, 'uncaughtException')
      const ur = (e: unknown) => { this.enqueue(toError(e), false, undefined, undefined, 'unhandledrejection'); void this.flush() }
      proc.on('uncaughtException', ue); proc.on('unhandledRejection', ur)
      this.off.push(() => { proc.off('uncaughtException', ue); proc.off('unhandledRejection', ur) })
      return
    }
    if (typeof g.addEventListener !== 'function') return
    const onError = (ev: any) => { if (ev?.error || ev?.message) this.enqueue(ev.error ? toError(ev.error) : { type: 'Error', message: String(ev.message), stack: ev.filename ? `at ${ev.filename}:${ev.lineno}:${ev.colno}` : undefined }, false, undefined, undefined, 'onerror') }
    const onRejection = (ev: any) => this.enqueue(toError(ev?.reason), false, undefined, undefined, 'unhandledrejection')
    const onHide = () => { if (this.queue.length) { write(this.storageKey, this.queue); void this.flush() } }
    const onNav = () => this.addBreadcrumb({ type: 'navigation', message: g.location?.pathname })
    g.addEventListener('error', onError); g.addEventListener('unhandledrejection', onRejection); g.addEventListener('pagehide', onHide); g.addEventListener('popstate', onNav)
    this.off.push(() => { g.removeEventListener('error', onError); g.removeEventListener('unhandledrejection', onRejection); g.removeEventListener('pagehide', onHide); g.removeEventListener('popstate', onNav) })
  }

  // Once a day per install and release, for crash-free users in Studio.
  private session() {
    const day = new Date().toISOString().slice(0, 10), k = `${this.storageKey}-session`, mark = `${day}|${this.opts.release ?? ''}`
    if (!isNode && read(k) === mark) return
    write(k, mark)
    this.fetch(`${this.url}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ release: this.opts.release ?? null, install_id: this.installId, environment: this.opts.environment }) })
      .then((r) => { if (r.status === 404) this.disabled = true }, () => {})
  }
}
