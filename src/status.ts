/**
 * Your app's public status page (turned on in Studio): whether the API, Auth, Storage, Edge Functions, Realtime, the
 * database and your own URLs are up, 90 days of uptime, incidents and maintenance. Show it in your app or site, embed
 * the badge, and let people subscribe to e-mail updates. No key is needed and nothing here is private.
 *
 * @example
 * ```ts
 * const { data } = await stitchdb.status.get()
 * if (data && data.overall !== 'operational') showBanner(data.overall_label)
 * await stitchdb.status.subscribe('ana@example.com') // she gets a link to confirm
 * img.src = stitchdb.status.badgeUrl({ component: 'api' })
 * ```
 *
 * @module status
 */
import type { Fetch } from './lib/types'

export class StatusError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'StatusError' }
}
type Result<T> = { data: T; error: null } | { data: null; error: StatusError }

export type ComponentStatus = 'operational' | 'degraded' | 'down' | 'maintenance' | 'unknown'
export type StatusComponent = {
  id: string; name: string; description: string | null; status: ComponentStatus
  since: string | null; response_ms: number | null; checked_at: string | null
  /** Percent of checks that answered in the last 90 days, or null before the first check. */
  uptime_90d: number | null
  /** One entry per day, oldest first. */
  history: { day: string; status: 'operational' | 'degraded' | 'down' | 'unknown'; uptime?: number; down_minutes?: number }[]
}
export type StatusIncident = {
  id: string; title: string; impact: 'minor' | 'major' | 'critical' | 'maintenance'
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'scheduled' | 'in_progress' | 'completed'
  components?: string[]; starts_at?: string | null; ends_at?: string | null
  updates?: { status: string; message: string; at: string }[]
  [key: string]: unknown
}
export type StatusSummary = {
  title: string; description: string | null; url: string | null
  overall: ComponentStatus; overall_label: string
  components: StatusComponent[]; incidents: StatusIncident[]; updated_at: string
}

export class StatusClient {
  /** @param url `https://<ref>.<zone>/status/v1`, or the same path on the custom domain of the page. */
  constructor(private url: string, private fetch: Fetch) {}

  /** The current state of every component, 90 days of history and the latest incidents (cached for about 30 s). */
  async get(): Promise<Result<StatusSummary>> {
    try {
      const res = await this.fetch(`${this.url}/status.json`, { method: 'GET' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new StatusError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j as StatusSummary, error: null }
    } catch (e: any) { return { data: null, error: new StatusError(e?.message || String(e), 0) } }
  }

  /**
   * Subscribe an e-mail address to incident and maintenance updates. The address gets a link to confirm first
   * (double opt-in); the answer is the same whether it was subscribed already or not. Needs e-mail updates turned on
   * for the page (otherwise 404).
   */
  async subscribe(email: string): Promise<Result<{ ok: true; message: string }>> {
    try {
      const res = await this.fetch(`${this.url}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new StatusError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j as { ok: true; message: string }, error: null }
    } catch (e: any) { return { data: null, error: new StatusError(e?.message || String(e), 0) } }
  }

  /** The public page (HTML) to link to. */
  pageUrl(): string { return `${this.url}/` }
  /** The JSON that get() reads, for other tools. */
  jsonUrl(): string { return `${this.url}/status.json` }
  /** An SVG badge for a README or a site: the overall state, or one component's, with your own label. */
  badgeUrl(options: { component?: string; label?: string } = {}): string {
    const q = new URLSearchParams()
    if (options.component) q.set('component', options.component)
    if (options.label) q.set('label', options.label)
    return `${this.url}/badge.svg${q.size ? `?${q}` : ''}`
  }
}
