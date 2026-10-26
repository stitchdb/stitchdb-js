/**
 * Product analytics: the events your app tracks, linked to the signed-in user (an anonymous id before sign-in, merged
 * into the user when they sign in), for active users, funnels, retention and breakdowns in Studio › Analytics.
 *
 * @example
 * ```ts
 * stitchdb.analytics.start({ release: '1.4.0' })
 * stitchdb.analytics.track('purchase', { plan: 'pro', amount: 29 })
 * await stitchdb.analytics.optOut() // the user does not want to be tracked
 * ```
 *
 * Nothing is sent until you call `start()` and the project has analytics turned on (Studio › Analytics); events
 * tracked before `start()` wait in memory (up to 100). Events are sent in batches in the background and kept (in
 * localStorage in browsers) while offline. Passwords, tokens, keys and e-mail addresses are removed by StitchDB before
 * anything is stored.
 *
 * @module analytics
 */
import type { Fetch } from './lib/types'

export type AnalyticsEvent = { name: string; props?: Record<string, unknown>; at?: string }
export type AnalyticsOptions = {
  /** Your app's version, for the breakdown by release. */
  release?: string
  /** Page views on the web as `$pageview` events with the path (default true in browsers). */
  trackPageViews?: boolean
  /** Change an event, or return null to drop it. */
  beforeSend?: (event: AnalyticsEvent) => AnalyticsEvent | null
  /** Send every N ms (default 10 000) or when 20 events are waiting. */
  flushIntervalMs?: number
}

const MAX_QUEUE = 1000, MAX_EARLY = 100, BATCH = 100
const store = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null } }
const read = (k: string) => { try { const v = store()?.getItem(k); return v ? JSON.parse(v) : null } catch { return null } }
const write = (k: string, v: unknown) => { try { if (v == null) store()?.removeItem(k); else store()?.setItem(k, JSON.stringify(v)) } catch { /* private mode, quota */ } }
const g: any = typeof globalThis !== 'undefined' ? globalThis : {}
const isNode = typeof g.process !== 'undefined' && !!g.process.versions?.node && typeof g.window === 'undefined'
const randomId = () => { try { return g.crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` } }
const NAME_RE = /^[$A-Za-z0-9_][\w$.:\- /]{0,63}$/

function platformInfo(): { platform: string; os?: string; country?: string } {
  if (isNode) return { platform: 'node', os: g.process.platform }
  const n = g.navigator || {}
  const ua = String(n.userAgent || '')
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : undefined
  const region = String(n.language || '').split('-')[1]
  return { platform: 'web', os, ...(region && /^[A-Za-z]{2}$/.test(region) ? { country: region.toUpperCase() } : {}) }
}

export class AnalyticsClient {
  private opts: AnalyticsOptions = {}
  private started = false
  private queue: AnalyticsEvent[] = []
  private sending: Promise<void> | null = null
  private anonId: string
  private sessionId = randomId()
  private timer: any = null
  private off: Array<() => void> = []
  private disabled = false
  private optedOut: boolean

  constructor(private url: string, private fetch: Fetch, private storageKey: string, private onAuthChange?: (cb: () => void) => () => void) {
    this.anonId = (read(`${storageKey}-anon`) as string) || randomId()
    write(`${storageKey}-anon`, this.anonId)
    this.optedOut = read(`${storageKey}-optout`) === true
  }

  /** Start sending: events tracked so far and the ones kept from earlier runs go out in the background. */
  start(options: AnalyticsOptions = {}): this {
    this.opts = { trackPageViews: true, flushIntervalMs: 10000, ...options }
    if (this.started) return this
    this.started = true
    this.disabled = false
    const saved = read(this.storageKey)
    if (Array.isArray(saved) && saved.length) this.queue.unshift(...saved.slice(-MAX_QUEUE))
    this.timer = setInterval(() => { void this.flush() }, Math.max(1000, this.opts.flushIntervalMs || 10000))
    if (typeof this.timer?.unref === 'function') this.timer.unref()
    this.off.push(() => clearInterval(this.timer))
    // a batch belongs to one user: send what is waiting before the user changes
    if (this.onAuthChange) this.off.push(this.onAuthChange(() => { void this.flush() }))
    if (!isNode && typeof g.addEventListener === 'function') {
      const hide = () => { if (g.document?.visibilityState !== 'visible') void this.flush(true) }
      g.addEventListener('visibilitychange', hide); g.addEventListener('pagehide', hide)
      this.off.push(() => { g.removeEventListener('visibilitychange', hide); g.removeEventListener('pagehide', hide) })
      if (this.opts.trackPageViews && g.location && g.history) {
        let last = ''
        const page = () => { const p = g.location.pathname; if (p !== last) { const first = !last; last = p; this.track('$pageview', { path: p, ...(first && g.document?.referrer ? { referrer: g.document.referrer } : {}) }) } }
        const wrap = (k: 'pushState' | 'replaceState') => { const orig = g.history[k]; g.history[k] = function (this: any, ...a: any[]) { const r = orig.apply(this, a); page(); return r }; return () => { g.history[k] = orig } }
        this.off.push(wrap('pushState'), wrap('replaceState'))
        g.addEventListener('popstate', page); this.off.push(() => g.removeEventListener('popstate', page))
        page()
      }
    }
    void this.flush()
    return this
  }

  /** Stop sending and tracking page views (for example when the user withdraws consent). Waiting events stay on the device. */
  stop(): void {
    this.started = false
    for (const f of this.off.splice(0)) f()
    if (this.queue.length) write(this.storageKey, this.queue.slice(-MAX_QUEUE))
  }

  /** Track an event with properties (flat values are easiest to break down by). */
  track(name: string, props: Record<string, unknown> = {}): void {
    if (this.optedOut || this.disabled) return
    if (!NAME_RE.test(name)) { console.warn(`stitchdb analytics: "${name}" is not a valid event name (letters, digits, _ $ . : - / and spaces, up to 64)`); return }
    let ev: AnalyticsEvent | null = { name, props, at: new Date().toISOString() }
    if (this.opts.beforeSend) { try { ev = this.opts.beforeSend(ev) } catch { ev = null } }
    if (!ev) return
    this.queue.push(ev)
    const max = this.started ? MAX_QUEUE : MAX_EARLY
    if (this.queue.length > max) this.queue.splice(0, this.queue.length - max)
    if (this.started && this.queue.length >= 20) void this.flush()
  }

  /** The user does not want to be tracked: their events are deleted and no new ones are sent (remembered on this device). */
  async optOut(): Promise<void> {
    this.optedOut = true
    this.queue = []
    write(this.storageKey, null)
    write(`${this.storageKey}-optout`, true)
    try { await this.fetch(`${this.url}/opt-out`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }) } catch { /* the device remembers it */ }
  }
  /** Track again after optOut(). */
  async optIn(): Promise<void> {
    this.optedOut = false
    write(`${this.storageKey}-optout`, null)
    try { await this.fetch(`${this.url}/opt-out`, { method: 'DELETE' }) } catch { /* ok */ }
  }
  get isOptedOut(): boolean { return this.optedOut }
  /** The id of this device or browser before sign-in. */
  get anonymousId(): string { return this.anonId }

  /** Send what is waiting now (before a serverless function returns, for example). */
  flush(closing = false): Promise<void> {
    if (!this.started || this.optedOut) return Promise.resolve()
    if (this.sending) return this.sending.then(() => (this.queue.length && !this.disabled ? this.flush(closing) : undefined))
    this.sending = (async () => {
      await null
      try {
        while (this.queue.length && !this.disabled) {
          const events = this.queue.slice(0, BATCH)
          const body = JSON.stringify({ anon_id: this.anonId, session_id: this.sessionId, release: this.opts.release ?? null, ...platformInfo(), events })
          const res = await this.fetch(`${this.url}/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: closing && body.length < 60000 } as any)
          if (res.status === 404 || res.status === 403) { this.disabled = true; this.queue = []; break } // analytics is off for the project
          if (res.status === 429) throw new Error('429') // the month's events are used up: keep them for later
          if (!res.ok && res.status !== 400 && res.status !== 413) throw new Error(String(res.status))
          this.queue.splice(0, events.length)
        }
        write(this.storageKey, null)
      } catch {
        write(this.storageKey, this.queue.slice(-MAX_QUEUE)) // offline or busy: next time
      } finally { this.sending = null }
    })()
    return this.sending
  }
}
