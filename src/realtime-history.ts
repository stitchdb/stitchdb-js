import type RealtimeChannel from './realtime/RealtimeChannel'
import type { Fetch } from './lib/types'

type Msg = { type: 'broadcast'; event: string; payload: any; meta?: { id?: string; replayed?: boolean } }
type Handler = { event: string; cb: (m: Msg) => void }
type Options = { since?: number | Date; onError?: (error: Error) => void }

const SEEN_MAX = 2000

/**
 * Message history for one channel (`config: { history: true }`): broadcast listeners go through here, so after every
 * (re)join the broadcasts the client missed are fetched from /history/v1/messages and delivered first, in order, then
 * the live ones that arrived meanwhile. Ids already delivered are skipped.
 */
export function withHistory(
  ch: RealtimeChannel,
  opts: Options | true,
  http: { url: string; fetch: Fetch; headers: () => Promise<Record<string, string>> }
): RealtimeChannel {
  const o: Options = opts === true ? {} : opts
  const handlers: Handler[] = []
  const seen = new Set<string>()
  let last: string | null = null
  let since: number | null = o.since == null ? null : +new Date(o.since)
  let catching = false
  let again = false
  let buffer: Msg[] = []
  const priv = !!ch.params.config.private

  const mark = (id?: string) => {
    if (!id) return
    seen.add(id)
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string)
  }
  const deliver = (m: Msg) => {
    if (m.meta?.id) last = m.meta.id
    for (const h of handlers) if (h.event === '*' || h.event === m.event) h.cb(m)
  }
  const live = (m: Msg) => {
    const id = m.meta?.id
    if (id && seen.has(id)) return
    mark(id)
    if (catching) buffer.push(m)
    else deliver(m)
  }

  async function catchUp() {
    if (catching) {
      again = true
      return
    }
    if (!last && since == null) return
    catching = true
    try {
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ topic: ch.subTopic, private: String(priv), limit: '200' })
        if (last) q.set('after', last)
        else if (since != null) q.set('since', String(since))
        const res = await http.fetch(`${http.url}/messages?${q}`, { headers: await http.headers() })
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.message || `Message history: HTTP ${res.status}`)
        for (const r of body.messages || []) {
          if (seen.has(r.id)) {
            last = r.id
            continue
          }
          mark(r.id)
          deliver({ type: 'broadcast', event: r.event, payload: r.payload, meta: { id: r.id, replayed: true } })
        }
        since = null
        if (!body.more) break
      }
    } catch (e) {
      o.onError?.(e as Error)
    } finally {
      const b = buffer
      buffer = []
      catching = false
      for (const m of b) deliver(m)
      if (again) {
        again = false
        catchUp()
      }
    }
  }

  const on = ch.on.bind(ch) as any
  on('broadcast', { event: '*' }, (m: Msg) => live(m))
  ;(ch as any).on = (type: string, filter: any, cb: any) => {
    if (type !== 'broadcast') return on(type, filter, cb)
    handlers.push({ event: filter?.event ?? '*', cb })
    return ch
  }
  const subscribe = ch.subscribe.bind(ch)
  ;(ch as any).subscribe = (cb?: (status: any, err?: Error) => void, timeout?: number) =>
    subscribe((status: any, err?: Error) => {
      if (status === 'SUBSCRIBED') catchUp()
      cb?.(status, err)
    }, timeout)

  ch._history = {
    async publish(event, payload) {
      const res = await http.fetch(`${http.url}/messages`, {
        method: 'POST',
        headers: { ...(await http.headers()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: ch.subTopic, event, payload, private: priv }),
      })
      const body: any = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.message || `publish: HTTP ${res.status}`)
      return body
    },
  }
  return ch
}
