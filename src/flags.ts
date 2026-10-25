/**
 * Feature flags and remote config: turn features on for some users (a plan, a segment, a percentage), and read
 * values (text, numbers, JSON) your app uses at runtime, changed in Studio › Integrations › Feature flags without
 * releasing the app.
 *
 * @example
 * ```ts
 * await stitchdb.flags.load({ attributes: { app_version: '2.4.1', country: 'DE' } })
 * if (stitchdb.flags.get('new-checkout', false)) showNewCheckout()
 * const limit = stitchdb.flags.get('upload-limit-mb', 10)
 * stitchdb.flags.on('change', () => render())
 * ```
 *
 * Flags are evaluated by StitchDB for the signed-in user (from the session, so a user cannot pretend to be on another
 * plan) and the attributes the app sends. The last values are kept (in localStorage in browsers), so `get` answers
 * at once on the next start and keeps working offline; the default you pass is used until a value is known.
 *
 * @module flags
 */
import type { Fetch } from './lib/types'

type Result<T> = { data: T; error: null } | { data: null; error: FlagsError }

export class FlagsError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'FlagsError' }
}

export type FlagValue = { value: any; variation: number; reason: string }
export type FlagAttributes = Record<string, string | number | boolean | null | Array<string | number>>

export type FlagsLoadOptions = {
  /** Attributes rules can target as attr.<name>: app version, country, platform … (not trusted: fine for targeting, not for access). */
  attributes?: FlagAttributes
  /** Only these flags (default: all flags the app may see). */
  keys?: string[]
  /** Seconds between refreshes while the app runs (default 60; 0 to refresh only when you call refresh()). */
  refreshInterval?: number
}

/** A user for server-side evaluation with the service key. */
export type FlagUser = { id: string; email?: string | null; role?: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }

const store = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null } }
const read = (k: string) => { try { const v = store()?.getItem(k); return v ? JSON.parse(v) : null } catch { return null } }
const write = (k: string, v: unknown) => { try { store()?.setItem(k, JSON.stringify(v)) } catch { /* private mode, quota */ } }

export class FlagsClient {
  private values: Record<string, FlagValue> = {}
  private version = 0
  private userId: string | null = null
  private opts: FlagsLoadOptions = {}
  private listeners = new Set<(keys: string[]) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<Result<Record<string, FlagValue>>> | null = null
  private loaded = false
  private anonId: string | null = null

  constructor(private url: string, private fetch: Fetch, private storageKey: string, onAuthChange: (cb: () => void) => void) {
    const cached = read(this.storageKey)
    if (cached && typeof cached === 'object' && cached.flags) { this.values = cached.flags; this.version = cached.version || 0; this.userId = cached.user_id ?? null }
    // a sign-in or sign-out changes who the flags are for
    onAuthChange(() => { if (this.loaded) void this.refresh() })
  }

  /** The id used to keep percentage rollouts stable for a visitor who is not signed in (kept in localStorage). */
  private anon(): string {
    if (this.anonId) return this.anonId
    const k = `${this.storageKey}-anon-id`
    let id = (() => { try { return store()?.getItem(k) || null } catch { return null } })()
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
      try { store()?.setItem(k, id) } catch { /* not kept: a new id per start */ }
    }
    return (this.anonId = id)
  }

  /** Fetch the flags for the current user (call once at start; refreshes after that on its own). */
  load(options: FlagsLoadOptions = {}): Promise<Result<Record<string, FlagValue>>> {
    this.opts = { ...this.opts, ...options }
    this.loaded = true
    const every = this.opts.refreshInterval ?? 60
    if (this.timer) clearInterval(this.timer)
    this.timer = every > 0 ? setInterval(() => { void this.refresh() }, every * 1000) : null
    ;(this.timer as any)?.unref?.()
    return this.refresh()
  }

  /** Fetch again now (also done on sign-in, sign-out and every refreshInterval seconds). */
  refresh(): Promise<Result<Record<string, FlagValue>>> {
    return (this.inflight ||= this.fetchFlags().finally(() => { this.inflight = null }))
  }

  private async fetchFlags(): Promise<Result<Record<string, FlagValue>>> {
    try {
      const res = await this.fetch(`${this.url}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: this.opts.attributes || {}, keys: this.opts.keys, anon_id: this.anon() }) })
      const j = await res.json().catch(() => ({}))
      // keep serving the last values when the service is off, over the plan's requests or unreachable
      if (!res.ok) return { data: null, error: new FlagsError(j.message || `Request failed (${res.status})`, res.status) }
      const prev = this.values
      this.values = j.flags || {}
      this.version = j.version || 0
      this.userId = j.user_id ?? null
      write(this.storageKey, { flags: this.values, version: this.version, user_id: this.userId })
      const changed = [...new Set([...Object.keys(prev), ...Object.keys(this.values)])]
        .filter((k) => JSON.stringify(prev[k]?.value) !== JSON.stringify(this.values[k]?.value))
      if (changed.length) for (const l of this.listeners) { try { l(changed) } catch (e) { console.error(e) } }
      return { data: this.values, error: null }
    } catch (e: any) {
      return { data: null, error: new FlagsError(e?.message || String(e), 0) }
    }
  }

  /** Set the attributes rules target (attr.<name>) and fetch again. */
  setAttributes(attributes: FlagAttributes): Promise<Result<Record<string, FlagValue>>> {
    this.opts.attributes = { ...(this.opts.attributes || {}), ...attributes }
    return this.refresh()
  }

  /** A flag's value, or `fallback` while it is not known (not loaded yet, deleted, or server-only). */
  get<T>(key: string, fallback: T): T {
    const v = this.values[key]
    return v === undefined || v.value === null || v.value === undefined ? fallback : (v.value as T)
  }
  /** Whether a boolean flag is on (false when not known). */
  isOn(key: string): boolean { return this.get<unknown>(key, false) === true }
  /** The value, which variation it is and why (off, rule:0, default, default:split …), for debugging. */
  detail(key: string): FlagValue | undefined { return this.values[key] }
  /** Every known flag's value. */
  all(): Record<string, any> { return Object.fromEntries(Object.entries(this.values).map(([k, v]) => [k, v.value])) }
  /** The definition version the values come from (grows with every change in Studio). */
  get configVersion(): number { return this.version }

  /** Called with the changed keys whenever a refresh changes values. Returns a function that stops listening. */
  on(event: 'change', cb: (keys: string[]) => void): () => void {
    if (event !== 'change') throw new Error(`Unknown event ${event}`)
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Stop refreshing (values stay readable). */
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  /**
   * Server side, with the service key: the flags for any user, including flags marked server-only.
   *
   * ```ts
   * const { data } = await admin.flags.evaluate({ id: user.id, email: user.email, app_metadata: user.app_metadata }, { country: 'DE' })
   * if (data['new-pricing'].value) …
   * ```
   */
  async evaluate(user: FlagUser | null, attributes: FlagAttributes = {}, options: { keys?: string[]; anonId?: string } = {}): Promise<Result<Record<string, FlagValue>>> {
    try {
      const res = await this.fetch(`${this.url}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user || undefined, attributes, keys: options.keys, anon_id: options.anonId }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new FlagsError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j.flags || {}, error: null }
    } catch (e: any) {
      return { data: null, error: new FlagsError(e?.message || String(e), 0) }
    }
  }
}
