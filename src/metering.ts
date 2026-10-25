/**
 * Usage metering per customer: record what each of your own customers uses (AI tokens, documents, minutes, seats …)
 * and read it back per customer for billing, plan limits or a usage page in your app. Meters are set up in
 * Studio › Integrations › Usage metering; API requests and file storage per user can be counted automatically.
 *
 * @example
 * ```ts
 * // server side, with the service key: any customer
 * await admin.metering.record('ai_tokens', 1532, { customer: org.id, idempotencyKey: completion.id })
 * const { data } = await admin.metering.usage({ customer: org.id, group: 'month' })
 *
 * // in the app, signed in: meters marked "apps may record", for the user's own customer
 * await stitchdb.metering.record('exports')
 * const { data: mine } = await stitchdb.metering.usage({ from: startOfMonth })
 * ```
 *
 * @module metering
 */
import type { Fetch } from './lib/types'

export class MeteringError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'MeteringError' }
}
type Result<T> = { data: T; error: null } | { data: null; error: MeteringError }

export type MeterEvent = {
  meter: string
  /** How much (default 1). For a gauge meter (seats, storage) the current value. */
  quantity?: number
  /** Your customer's id (a user id, an organization id …). Server side only; a signed-in user records for themselves. */
  customer?: string
  /** The same key is counted once (retries, webhooks delivered twice). */
  idempotencyKey?: string
  /** When it happened (server side, up to 35 days back; default now). */
  at?: Date | string
}
export type UsageRow = { customer: string; meter: string; period: string; value: number }
export type UsageQuery = {
  /** Server side: one customer (default all). A signed-in user always reads their own. */
  customer?: string
  meter?: string
  /** Default: 30 days ago. */
  from?: Date | string
  /** Default: now. */
  to?: Date | string
  /** Rows per hour, day (default) or month. */
  group?: 'hour' | 'day' | 'month'
}
export type UsageResult = {
  from: string; to: string; group: string; customer?: string; truncated: boolean
  meters: Record<string, { name: string; unit: string | null; aggregation: 'sum' | 'max' }>
  rows: UsageRow[]
}
export type CustomerTotals = { customer: string; totals: Record<string, number> }

const iso = (d?: Date | string) => (d instanceof Date ? d.toISOString() : d)
const qs = (o: Record<string, unknown>) => {
  const q = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(iso(v as any))]))
  return q.size ? `?${q}` : ''
}

export class MeteringClient {
  constructor(private url: string, private fetch: Fetch) {}
  private async req<T>(path: string, body?: unknown): Promise<Result<T>> {
    try {
      const res = await this.fetch(this.url + path, body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return { data: null, error: new MeteringError(j.message || `Request failed (${res.status})`, res.status) }
      return { data: j as T, error: null }
    } catch (e: any) { return { data: null, error: new MeteringError(e?.message || String(e), 0) } }
  }
  private static wire(e: MeterEvent) {
    return { meter: e.meter, quantity: e.quantity, customer: e.customer, idempotency_key: e.idempotencyKey, at: iso(e.at) }
  }
  /** Record usage of one meter. */
  record(meter: string, quantity = 1, options: Omit<MeterEvent, 'meter' | 'quantity'> = {}): Promise<Result<{ recorded: number; duplicates: number }>> {
    return this.req('/record', MeteringClient.wire({ meter, quantity, ...options }))
  }
  /** Record up to 1,000 events in one request. */
  recordMany(events: MeterEvent[]): Promise<Result<{ recorded: number; duplicates: number }>> {
    return this.req('/record', { events: events.map(MeteringClient.wire) })
  }
  /** Usage per customer, meter and period: the sum for sum meters, the highest value for gauge meters. */
  usage(query: UsageQuery = {}): Promise<Result<UsageResult>> { return this.req(`/usage${qs(query)}`) }
  /** Totals per customer for a period, largest first (service key). */
  customers(query: { from?: Date | string; to?: Date | string; meter?: string; search?: string; limit?: number; offset?: number } = {}): Promise<Result<{ customers: CustomerTotals[]; total: number; sorted_by: string }>> {
    return this.req(`/customers${qs(query)}`)
  }
  /** Every row of a period as CSV text (customer,meter,period,value), for your billing system (service key). */
  async exportCsv(query: Omit<UsageQuery, 'customer'> = {}): Promise<Result<string>> {
    try {
      const res = await this.fetch(this.url + `/export${qs({ ...query, format: 'csv' })}`, { method: 'GET' })
      const t = await res.text()
      if (!res.ok) { let m = t; try { m = JSON.parse(t).message } catch {} return { data: null, error: new MeteringError(m || `Request failed (${res.status})`, res.status) } }
      return { data: t, error: null }
    } catch (e: any) { return { data: null, error: new MeteringError(e?.message || String(e), 0) } }
  }
}
