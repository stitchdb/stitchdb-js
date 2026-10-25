import type { Fetch } from './lib/types'

/** A device to register: an APNs token (iOS), an FCM registration token (Android) or a browser PushSubscription. */
export type PushDevice =
  | { platform: 'ios' | 'android'; token: string; topics?: string[]; app?: string }
  | { platform: 'web'; subscription: PushSubscriptionJSON | { endpoint: string; keys: { p256dh: string; auth: string } }; topics?: string[] }

export type PushMessage = {
  /** One user, several users (up to 10,000) or a topic. */
  user_id?: string
  user_ids?: string[]
  topic?: string
  title?: string
  body?: string
  /** Extra data for your app (up to 3 KB). */
  data?: Record<string, unknown>
  badge?: number
  sound?: string
  /** Also store it in the users' in-app inbox (default true; not for topics). */
  inbox?: boolean
  /** Send later. */
  send_at?: string | Date
}

export type InboxNotification = {
  id: number
  title: string | null
  body: string | null
  data: Record<string, unknown>
  created_at: string
  read_at: string | null
}

export class PushError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PushError'
    this.status = status
  }
}

type Channel = {
  on: (...args: any[]) => Channel
  subscribe: (cb?: (status: string) => void) => Channel
}

/**
 * Push notifications and the in-app inbox (`stitchdb.push`). Devices are registered by the signed-in user;
 * sending needs the service role key (server side).
 */
export class PushClient {
  constructor(
    private url: string,
    private fetch: Fetch,
    private channel: (name: string) => Channel,
    private removeChannel: (ch: Channel) => unknown,
    private currentUserId: () => Promise<string | null>
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(this.url + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new PushError(json.message || `Push request failed (${res.status})`, res.status)
    return json as T
  }

  /** Which platforms are set up for this project, and the Web Push public key (VAPID). */
  config(): Promise<{ vapid_public_key: string | null; ios: boolean; android: boolean; web: boolean }> {
    return this.req('GET', '/config')
  }

  /** Register this device for the signed-in user (call after sign-in and whenever the token changes). */
  register(device: PushDevice): Promise<{ id: string; platform: string; topics: string[] }> {
    return this.req('POST', '/devices', device)
  }

  /** Remove this device (call on sign-out). */
  unregister(device: PushDevice): Promise<{ removed: number }> {
    return this.req('DELETE', '/devices', device)
  }

  /** Browser: ask for permission, subscribe with the project's key and register. Pass your service worker registration. */
  async registerBrowser(sw: ServiceWorkerRegistration, opts: { topics?: string[] } = {}): Promise<PushSubscription> {
    const { vapid_public_key } = await this.config()
    if (!vapid_public_key) throw new PushError('Push notifications are not turned on for this project', 409)
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      if ((await Notification.requestPermission()) !== 'granted') throw new PushError('Notification permission was not granted', 403)
    }
    const key = Uint8Array.from(atob(vapid_public_key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const sub = (await sw.pushManager.getSubscription()) || (await sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
    await this.register({ platform: 'web', subscription: sub.toJSON(), topics: opts.topics })
    return sub
  }

  /** Subscribe the signed-in user's devices (or one device) to a topic. */
  subscribe(topic: string, device?: PushDevice): Promise<{ devices: number }> {
    return this.req('POST', `/topics/${encodeURIComponent(topic)}/subscribe`, device || {})
  }

  unsubscribe(topic: string, device?: PushDevice): Promise<{ devices: number }> {
    return this.req('POST', `/topics/${encodeURIComponent(topic)}/unsubscribe`, device || {})
  }

  /** Send (service role key only: Edge Functions or your server). Delivery happens within a second or two. */
  send(message: PushMessage): Promise<{ id: number; status: 'queued' }> {
    const m = { ...message, send_at: message.send_at instanceof Date ? message.send_at.toISOString() : message.send_at }
    return this.req('POST', '/send', m)
  }

  /** Delivery result of a sent message (service role key). */
  status(id: number): Promise<{ id: number; status: string; devices: number; sent: number; failed: number; error: string | null }> {
    return this.req('GET', `/messages/${id}`)
  }

  /** The signed-in user's in-app inbox, newest first. */
  inbox(opts: { unread?: boolean; limit?: number; before?: number } = {}): Promise<{ notifications: InboxNotification[]; unread: number }> {
    const q = new URLSearchParams()
    if (opts.unread) q.set('unread', 'true')
    if (opts.limit) q.set('limit', String(opts.limit))
    if (opts.before) q.set('before', String(opts.before))
    return this.req('GET', `/inbox${q.size ? `?${q}` : ''}`)
  }

  /** Mark notifications read: a list of ids, or `'all'`. */
  markRead(ids: number[] | 'all'): Promise<{ marked: number }> {
    return this.req('POST', '/inbox/read', ids === 'all' ? { all: true } : { ids })
  }

  deleteNotifications(ids: number[]): Promise<{ deleted: number }> {
    return this.req('POST', '/inbox/delete', { ids })
  }

  /** New inbox notifications for the signed-in user, live (Realtime). Returns a function that stops listening. */
  async onNotification(callback: (n: InboxNotification) => void): Promise<() => void> {
    const uid = await this.currentUserId()
    if (!uid) throw new PushError('Sign in first', 401)
    const ch = this.channel(`push-inbox-${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'push', table: 'notifications', filter: `user_id=eq.${uid}` }, (p: { new: InboxNotification }) => callback(p.new))
      .subscribe()
    return () => void this.removeChannel(ch)
  }
}
