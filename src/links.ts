/**
 * Deep links and short links (Studio › Links): `https://<project host or your domain>/l/<code>` opens your app on the
 * right screen when it is installed (iOS Universal Links, Android App Links), and otherwise sends people to the App
 * Store, Google Play or a web page. Your app resolves the link it was opened with to its path and data, and on its
 * first launch after an install can ask which link led to the install (deferred deep link, best effort).
 *
 * @example
 * ```ts
 * // the app was opened by a link (React Native: Linking.getInitialURL() / the 'url' event)
 * const { data: link } = await stitchdb.links.resolve(url)
 * if (link) navigate(link.path, link.data)
 *
 * // first launch after an install (call once, store that you did)
 * const { data: first } = await stitchdb.links.deferred({ platform: 'ios' })
 *
 * // make a link: signed-in users when the project allows it, any link with the service key
 * const { data: made } = await stitchdb.links.create({ path: '/invite/7', data: { from: 'ana' } })
 * share(made.url)
 * ```
 *
 * @module links
 */
import type { Fetch } from './lib/types'

export class LinksError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'LinksError' }
}
type Result<T> = { data: T; error: null } | { data: null; error: LinksError }

/** What the app gets for a link. */
export type AppLink = {
  code: string
  /** The short link. */
  url: string
  /** The screen to show, as you stored it (for example `/product/42`), or null for the start screen. */
  path: string | null
  /** The data stored with the link. */
  data: Record<string, unknown>
  /** deferred() only: how the install was matched to the click. */
  matched_by?: 'referrer' | 'network'
}
export type LinkInput = {
  /** The screen the app shows (a path your router knows). */
  path?: string | null
  /** Up to 4 KB of JSON for the app. */
  data?: Record<string, unknown>
  /** Service key only: choose the code (letters, digits, _ and -); default a random 7-letter code. */
  code?: string
  /** Where people on a computer go (default: the project's web page). */
  web_url?: string | null
  /** Instead of the App Store / Google Play when the app is not installed. */
  ios_url?: string | null
  android_url?: string | null
  /** Shown when the link is shared in chats and social posts. */
  title?: string | null
  description?: string | null
  image_url?: string | null
  expires_at?: Date | string | null
  disabled?: boolean
}
export type Link = Required<Omit<LinkInput, 'expires_at' | 'code'>> & {
  code: string; url: string; expires_at: string | null; source: 'studio' | 'api' | 'user'; created_by: string | null
  clicks: number; opens: number; installs: number; last_click_at: string | null; created_at: string; updated_at: string
}
export type LinkStats = {
  link: Link; days: number
  daily: { day: string; clicks: number; opens: number; installs: number }[]
  platforms: { k: string; n: number }[]; countries: { k: string; n: number }[]; outcomes: { k: string; n: number }[]; referrers: { k: string; n: number }[]
}

const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const wire = (l: LinkInput) => ({ ...l, expires_at: l.expires_at instanceof Date ? l.expires_at.toISOString() : l.expires_at })

export class LinksClient {
  constructor(private url: string, private fetch: Fetch) {}
  private async req<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const res = await this.fetch(this.url + path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new LinksError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j as T, error: null }
    } catch (e: any) { return { data: null, error: new LinksError(e?.message || String(e), 0) } }
  }

  /** The code of a short link (`https://…/l/<code>`), or null for any other URL. A bare code is returned as is. */
  static codeFrom(urlOrCode: string): string | null {
    const s = String(urlOrCode || '').trim()
    if (CODE_RE.test(s)) return s
    try { const m = /^\/l\/([A-Za-z0-9_-]{1,64})\/?$/.exec(new URL(s).pathname); return m ? m[1] : null } catch { return null }
  }

  /**
   * The link the app was opened with: its path and data (counted as an open in Studio). `data` is null for a URL that
   * is not a short link; an expired or turned-off link is an error with status 410.
   */
  async resolve(urlOrCode: string, options: { platform?: 'ios' | 'android' | 'web' } = {}): Promise<Result<AppLink | null>> {
    const code = LinksClient.codeFrom(urlOrCode)
    if (!code) return { data: null, error: null }
    return this.req('GET', `/resolve/${code}${options.platform ? `?platform=${options.platform}` : ''}`)
  }

  /**
   * First launch after an install: the link that led to it, or null. Android apps pass the Play install referrer
   * (an exact match); otherwise the click is matched by network and platform within 2 hours — best effort, and each
   * click is handed out once. Call it once per install.
   */
  async deferred(options: { platform: 'ios' | 'android'; referrer?: string }): Promise<Result<AppLink | null>> {
    const r = await this.req<{ match: AppLink | null }>('POST', '/deferred', { platform: options.platform, referrer: options.referrer })
    return r.error ? r : { data: r.data.match, error: null }
  }

  /** Make a short link (signed-in users when the project allows it in Studio › Links, any link with the service key). */
  create(link: LinkInput): Promise<Result<Link>> { return this.req('POST', '/links', wire(link)) }
  /** Links, newest first (service key). */
  list(options: { search?: string; limit?: number; offset?: number } = {}): Promise<Result<{ links: Link[]; total: number }>> {
    const q = new URLSearchParams()
    if (options.search) q.set('q', options.search)
    if (options.limit != null) q.set('limit', String(options.limit))
    if (options.offset != null) q.set('offset', String(options.offset))
    return this.req('GET', `/links${q.size ? `?${q}` : ''}`)
  }
  /** One link with its clicks per day, platform, country, where people went and referrers (service key). */
  get(code: string, options: { days?: number } = {}): Promise<Result<LinkStats>> {
    return this.req('GET', `/links/${encodeURIComponent(code)}${options.days ? `?days=${options.days}` : ''}`)
  }
  update(code: string, patch: LinkInput): Promise<Result<Link>> { return this.req('PATCH', `/links/${encodeURIComponent(code)}`, wire(patch)) }
  remove(code: string): Promise<Result<{ deleted: string }>> { return this.req('DELETE', `/links/${encodeURIComponent(code)}`) }
}
