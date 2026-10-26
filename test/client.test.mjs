// Run after `npm run build`: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createClient, StitchClient, AuthError, MemoryStore } from '../dist/index.mjs'

const URL_ = 'https://abcdefghijklmnop.stitchdb.com'
const KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

// A fetch that records requests and answers from a routing function.
function mockFetch(route) {
  const calls = []
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined))
    const call = { url, method: init.method || 'GET', headers, body: init.body }
    calls.push(call)
    const [status, body, extra] = route(call) || [200, []]
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(extra || {}) } })
  }
  return { fetch, calls }
}
const memoryStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

test('createClient returns a StitchClient with every service', () => {
  const c = createClient(URL_, KEY, { auth: { persistSession: false } })
  assert.ok(c instanceof StitchClient)
  for (const k of ['auth', 'storage', 'functions', 'realtime']) assert.ok(c[k], k)
  assert.equal(typeof c.from, 'function'); assert.equal(typeof c.rpc, 'function'); assert.equal(typeof c.channel, 'function')
  assert.equal(typeof c.auth.signInWithWeb3, 'function', 'web3 sign-in is available')
  assert.equal(typeof c.auth.mfa.enroll, 'function')
  assert.throws(() => createClient('', KEY), /stitchUrl is required/)
})

test('REST queries: URL, filters, headers', async () => {
  const { fetch, calls } = mockFetch(() => [200, [{ id: 1, task: 'ship' }]])
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { persistSession: false } })
  const { data, error } = await c.from('todos').select('id, task').eq('is_complete', false).order('id').limit(5)
  assert.equal(error, null); assert.deepEqual(data, [{ id: 1, task: 'ship' }])
  const u = new URL(calls[0].url)
  assert.equal(u.origin + u.pathname, `${URL_}/rest/v1/todos`)
  assert.equal(u.searchParams.get('select'), 'id,task'); assert.equal(u.searchParams.get('is_complete'), 'eq.false')
  assert.equal(u.searchParams.get('order'), 'id.asc'); assert.equal(u.searchParams.get('limit'), '5')
  assert.equal(calls[0].headers.get('apikey'), KEY)
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`)
  assert.match(calls[0].headers.get('x-client-info'), new RegExp(`^stitchdb-js/${JSON.parse(readFileSync("package.json", "utf8")).version.replace(/\./g, "\\.")}`))
  await c.rpc('search', { term: 'x' })
  assert.equal(new URL(calls[1].url).pathname, '/rest/v1/rpc/search'); assert.equal(calls[1].method, 'POST')
})

test('REST errors come back as PostgrestError', async () => {
  const { fetch } = mockFetch(() => [404, { code: '42P01', message: 'relation "nope" does not exist', details: null, hint: null }])
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { persistSession: false } })
  const { error } = await c.from('nope').select()
  assert.equal(error.code, "42P01"); assert.match(error.message, /does not exist/)
})

test('auth: password sign-in stores the session under the stitchdb key and sends the user token', async () => {
  const access = jwt({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.includes('/auth/v1/token')) return [200, { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r1', user: { id: 'u1', aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } }]
    return [200, []]
  })
  const storage = memoryStorage()
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { storage, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email: 'a@example.com', password: 'x' })
  assert.equal(error, null); assert.equal(data.user.id, 'u1')
  assert.ok(storage.map.has('stitchdb-abcdefghijklmnop-auth-token'))
  assert.ok(![...storage.map.keys()].some((k) => k.startsWith('sb-')))
  await c.from('todos').select()
  assert.equal(calls.at(-1).headers.get('authorization'), `Bearer ${access}`)
  await c.auth.signOut({ scope: 'local' })
  assert.ok(!storage.map.has('stitchdb-abcdefghijklmnop-auth-token'))
})

test('auth errors are AuthError with codes (server legacy error format)', async () => {
  const { fetch } = mockFetch(() => [400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }])
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email: 'a@example.com', password: 'bad' })
  assert.ok(error instanceof AuthError); assert.equal(error.code, 'invalid_credentials'); assert.equal(error.message, 'Invalid login credentials')
})

test('sessions saved by earlier SDK versions are migrated, not lost', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const old = JSON.stringify({ access_token: jwt({ sub: 'u9', role: 'authenticated', exp }), refresh_token: 'r9', expires_at: exp, expires_in: 3600, token_type: 'bearer',
    user: { id: 'u9', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })
  const storage = memoryStorage({ 'sb-abcdefghijklmnop-auth-token': old, 'sb-abcdefghijklmnop-auth-token-code-verifier': '"v"' })
  const { fetch } = mockFetch(() => [200, []])
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { storage, autoRefreshToken: false } })
  const { data } = await c.auth.getSession()
  assert.equal(data.session?.user.id, 'u9', 'still signed in after the upgrade')
  assert.ok(storage.map.has('stitchdb-abcdefghijklmnop-auth-token'))
  assert.ok(!storage.map.has('sb-abcdefghijklmnop-auth-token'), 'old key removed')
  // A custom storageKey is left alone.
  const s2 = memoryStorage({ 'sb-abcdefghijklmnop-auth-token': old })
  const c2 = createClient(URL_, KEY, { global: { fetch }, auth: { storage: s2, storageKey: 'mine', autoRefreshToken: false } })
  assert.equal((await c2.auth.getSession()).data.session, null); assert.ok(s2.map.has('sb-abcdefghijklmnop-auth-token'))
})

test('storage and functions URLs', async () => {
  const { fetch, calls } = mockFetch((c) => (c.url.includes('/functions/') ? [200, { ok: true }] : [200, { Key: 'avatars/a.png', Id: '1' }]))
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { persistSession: false } })
  await c.storage.from('avatars').upload('u1/a.png', new Blob(['x']), { upsert: true })
  assert.equal(new URL(calls[0].url).pathname, '/storage/v1/object/avatars/u1/a.png')
  assert.equal(c.storage.from('avatars').getPublicUrl('u1/a.png').data.publicUrl, `${URL_}/storage/v1/object/public/avatars/u1/a.png`)
  const r = await c.functions.invoke('hello', { body: { name: 'Ada' } })
  assert.deepEqual(r.data, { ok: true })
  assert.equal(calls[1].url, `${URL_}/functions/v1/hello`); assert.equal(calls[1].method, 'POST')
})

test('CommonJS build and subpaths load', () => {
  const require = createRequire(import.meta.url)
  assert.equal(typeof require('../dist/index.cjs').createClient, 'function')
  assert.equal(typeof require('../dist/cors.cjs').corsHeaders, 'object')
})

test('no third-party brand names in the published files (license notices excepted)', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
  const files = [...walk('dist'), 'README.md', 'package.json']
  const bad = files.filter((f) => /supa\s*base/i.test(readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
})

test('push: devices, topics, inbox and send go to /push/v1 with the session token', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.endsWith('/push/v1/inbox?unread=true&limit=5')) return [200, { notifications: [{ id: 3, title: 'Hi' }], unread: 1 }]
    if (c.url.endsWith('/push/v1/send')) return [202, { id: 9, status: 'queued' }]
    if (c.url.endsWith('/push/v1/config')) return [200, { vapid_public_key: 'k', ios: true, android: false, web: true }]
    if (c.url.endsWith('/push/v1/devices') && c.method === 'POST') return [400, { message: 'platform must be ios, android or web' }]
    return [200, { ok: true }]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  assert.equal((await c.push.config()).vapid_public_key, 'k')
  const inbox = await c.push.inbox({ unread: true, limit: 5 })
  assert.equal(inbox.unread, 1)
  await c.push.markRead('all')
  assert.deepEqual(JSON.parse(calls.at(-1).body), { all: true })
  await c.push.subscribe('news')
  assert.ok(calls.at(-1).url.endsWith('/push/v1/topics/news/subscribe'))
  const when = new Date('2030-01-01T00:00:00Z')
  assert.equal((await c.push.send({ user_id: 'u', title: 't', send_at: when })).id, 9)
  assert.equal(JSON.parse(calls.at(-1).body).send_at, '2030-01-01T00:00:00.000Z')
  assert.equal(calls.at(-1).headers.get('apikey'), KEY)
  await assert.rejects(c.push.register({ platform: 'ios', token: 'x' }), (e) => e.name === 'PushError' && e.status === 400 && /platform/.test(e.message))
  for (const call of calls) assert.ok(call.url.startsWith('https://abcdefghijklmnop.stitchdb.com/push/v1/'), call.url)
})

test('search: POST /search/v1/<table>, errors returned not thrown', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.endsWith('/search/v1/posts')) return [200, { data: [{ id: 1 }], scores: [{ score: 0.03, keyword_rank: 1, semantic_rank: null }], mode: 'keyword', note: 'semantic search is not available right now' }]
    return [404, { message: 'public.nope has no search index' }]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  const r = await c.search('posts', 'shoes', { limit: 5, mode: 'hybrid' })
  assert.deepEqual(r.data, [{ id: 1 }]); assert.equal(r.mode, 'keyword'); assert.match(r.note, /not available/); assert.equal(r.error, null)
  assert.deepEqual(JSON.parse(calls[0].body), { q: 'shoes', limit: 5, mode: 'hybrid' })
  assert.equal(calls[0].headers.get('apikey'), KEY)
  const bad = await c.search('nope', 'x')
  assert.equal(bad.data, null); assert.equal(bad.error.name, 'SearchError'); assert.equal(bad.error.status, 404)
})

test('offline: writes queue while the server is down and survive a restart of the app', async () => {
  let up = false
  const pushed = []
  const { fetch } = mockFetch((c) => {
    if (!up) return [503, { message: 'down' }]
    if (c.url.endsWith('/sync/v1/tables')) return [200, { tables: [{ name: 'todos', pk: ['id'], conflict: 'last_write_wins' }] }]
    if (c.url.endsWith('/sync/v1/push')) { const b = JSON.parse(c.body); pushed.push(...b.mutations); return [200, { results: b.mutations.map((m) => ({ id: m.id, status: 'applied', seq: 7, pk: { id: m.row.id }, row: m.row })) }] }
    if (c.url.endsWith('/sync/v1/pull')) return [200, { changes: { todos: [{ seq: 8, op: 'u', pk: { id: 'b' }, row: { id: 'b', title: 'from server' } }] }, cursors: { todos: 8 }, more: false, reset: [] }]
  })
  const store = new MemoryStore()
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  up = true
  let off = c.offline({ store, interval: 0 }); await off.ready; await off.sync().catch(() => {})
  up = false
  await off.table('todos').upsert({ id: 'a', title: 'offline' })
  assert.equal(off.status.pending, 1)
  await off.close()
  off = c.offline({ store, interval: 0 }); await off.ready
  assert.equal(off.status.pending, 1, 'queue persisted')
  assert.equal(off.table('todos').get('a').title, 'offline')
  up = true
  await off.sync()
  assert.equal(off.status.pending, 0)
  assert.deepEqual(pushed.map((m) => [m.table, m.op, m.row.title, m.base]), [['todos', 'upsert', 'offline', null]])
  assert.match(pushed[0].id, /^[A-Za-z0-9_-]{16}\.\d+$/)
  assert.equal(off.table('todos').get('b').title, 'from server')
  await off.close({ clear: true })
})

test('purchases: sync, me and entitlements go to /purchases/v1', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.endsWith('/purchases/v1/sync')) return [200, { purchase: { id: 1, status: 'active' }, entitlements: ['pro'] }]
    if (c.url.endsWith('/purchases/v1/me')) return [200, { purchases: [], entitlements: ['pro'] }]
    if (c.url.endsWith('/purchases/v1/refresh')) return [401, { message: 'This needs the service_role key (server side only)' }]
    return [200, {}]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  const r = await c.purchases.sync({ store: 'apple', signed_transaction: 'a.b.c' })
  assert.deepEqual(r.entitlements, ['pro'])
  assert.deepEqual(JSON.parse(calls.at(-1).body), { store: 'apple', signed_transaction: 'a.b.c' })
  assert.equal(await c.purchases.hasEntitlement('pro'), true)
  assert.equal(await c.purchases.hasEntitlement('team'), false)
  await assert.rejects(c.purchases.refresh('u'), (e) => e.name === 'PurchasesError' && e.status === 401)
  for (const call of calls) assert.ok(call.url.startsWith('https://abcdefghijklmnop.stitchdb.com/purchases/v1/'), call.url)
})

test('orgs: calls the org_* functions over /rest/v1/rpc and maps errors', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.endsWith('/rest/v1/rpc/org_create')) return [200, { id: 'o1', name: 'Acme', role: 'owner', members: 1 }]
    if (c.url.endsWith('/rest/v1/rpc/org_invite')) return [200, { id: 'i1', email: 'b@example.com', role: 'admin', token: 't' }]
    if (c.url.endsWith('/rest/v1/rpc/org_set_role')) return [403, { code: '42501', message: 'Your role in this organization does not allow this' }]
    if (c.url.endsWith('/rest/v1/rpc/org_list')) return [404, { code: 'PGRST202', message: 'Could not find the function public.org_list without parameters' }]
    return [200, null]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  assert.equal((await c.orgs.create({ name: 'Acme' })).role, 'owner')
  assert.deepEqual(JSON.parse(calls.at(-1).body), { name: 'Acme' })
  assert.equal((await c.orgs.invite('o1', { email: 'b@example.com', role: 'admin' })).token, 't')
  assert.deepEqual(JSON.parse(calls.at(-1).body), { org: 'o1', email: 'b@example.com', role: 'admin' })
  await c.orgs.setActive('o1')
  assert.ok(calls.at(-1).url.endsWith('/rest/v1/rpc/org_set_active'))
  await assert.rejects(c.orgs.setRole('o1', 'u', 'member'), (e) => e.name === 'OrgsError' && e.status === 403 && e.code === '42501')
  await assert.rejects(c.orgs.list(), (e) => e.name === 'OrgsError' && /not turned on/.test(e.message))
})

test('realtime history: missed broadcasts are replayed in order after a rejoin, without duplicates; publish stores', async () => {
  const { RealtimeChannel } = await import('../dist/index.mjs')
  const proto = RealtimeChannel.prototype, orig = { on: proto.on, subscribe: proto.subscribe }
  proto.on = function (type, filter, cb) { (this._t ||= []).push([type, filter, cb]); return this }
  proto.subscribe = function (cb) { this._cb = cb; return this }
  try {
    let stored = [{ id: 'm1', event: 'msg', payload: { n: 1 } }, { id: 'm2', event: 'msg', payload: { n: 2 } }, { id: 'm3', event: 'other', payload: { n: 3 } }]
    const { fetch, calls } = mockFetch((c) => {
      const u = new URL(c.url)
      if (u.pathname === '/history/v1/messages' && c.method === 'POST') return [201, { id: 'p1', inserted_at: 'now' }]
      if (u.pathname === '/history/v1/messages') {
        const after = u.searchParams.get('after')
        const rest = after ? stored.slice(stored.findIndex((m) => m.id === after) + 1) : stored
        return [200, { messages: rest, more: false, gap: false }]
      }
      return [200, {}]
    })
    const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch }, accessToken: async () => KEY })
    const ch = c.channel('room-1', { config: { private: true, history: { since: 0 } } })
    const got = []
    ch.on('broadcast', { event: 'msg' }, (m) => got.push([m.payload.n, !!m.meta?.replayed]))
    ch.subscribe()
    const liveCb = ch._t.find(([t]) => t === 'broadcast')[2]
    ch._cb('SUBSCRIBED')
    liveCb({ type: 'broadcast', event: 'msg', payload: { n: 2 }, meta: { id: 'm2' } }) // also live while catching up
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(got, [[1, true], [2, false]]) // m2 came live during the catch-up: delivered once, after m1
    let u = new URL(calls[0].url)
    assert.equal(u.searchParams.get('topic'), 'room-1'); assert.equal(u.searchParams.get('since'), '0'); assert.equal(u.searchParams.get('private'), 'true')
    // live message, then a disconnect: m5 and m6 were sent while away
    liveCb({ type: 'broadcast', event: 'msg', payload: { n: 4 }, meta: { id: 'm4' } })
    stored = [...stored, { id: 'm4', event: 'msg', payload: { n: 4 } }, { id: 'm5', event: 'msg', payload: { n: 5 } }, { id: 'm6', event: 'msg', payload: { n: 6 } }]
    ch._cb('SUBSCRIBED')
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(got.map((g) => g[0]), [1, 2, 4, 5, 6])
    u = new URL(calls.at(-1).url)
    assert.equal(u.searchParams.get('after'), 'm4')
    const p = await ch.publish('msg', { n: 7 })
    assert.equal(p.id, 'p1')
    assert.deepEqual(JSON.parse(calls.at(-1).body), { topic: 'room-1', event: 'msg', payload: { n: 7 }, private: true })
    assert.equal(calls.at(-1).headers.get('apikey'), KEY)
    await assert.rejects(c.channel('plain').publish('x', {}), /history: true/)
  } finally { Object.assign(proto, orig) }
})

test('jobs: job() replays saved steps, yields one new step at a time, refuses unsigned calls; jobs.start()', async () => {
  const { job, execute, FatalJobError, parseDuration } = await import('../dist/jobs.mjs')
  const { createHmac } = await import('node:crypto')
  const ran = []
  const handler = async (p, ctx) => {
    const a = await ctx.step('a', () => { ran.push('a'); return p.n + 1 })
    await ctx.sleep('nap', '1h')
    const b = await ctx.step('b', () => { ran.push('b'); return a * 2 })
    return { b }
  }
  const run = { id: 'r1', job: 'j', attempt: 1, created_at: '' }
  assert.deepEqual(await execute(handler, run, { n: 1 }, {}), { op: 'step', name: 'a', output: 2 })
  const nap = await execute(handler, run, { n: 1 }, { a: { output: 2 } })
  assert.equal(nap.op, 'sleep'); assert.ok(Math.abs(new Date(nap.until) - Date.now() - 3600e3) < 5000)
  assert.deepEqual(await execute(handler, run, { n: 1 }, { a: { output: 2 }, nap: { output: null } }), { op: 'step', name: 'b', output: 4 })
  assert.deepEqual(await execute(handler, run, { n: 1 }, { a: { output: 2 }, nap: { output: null }, b: { output: 4 } }), { op: 'done', result: { b: 4 } })
  assert.deepEqual(ran, ['a', 'b'])
  const err = await execute(async (p, ctx) => ctx.step('x', () => { throw new FatalJobError('no') }), run, {}, {})
  assert.deepEqual(err, { op: 'error', name: 'x', message: 'no', retry: false })
  assert.equal(parseDuration('15m'), 900e3)

  const SK = jwt({ role: 'service_role' }), fn = job(handler, { serviceKey: SK })
  assert.equal((await fn(new Request('http://x/', { method: 'POST', body: '{}' }))).status, 401)
  const body = JSON.stringify({ run, payload: { n: 1 }, steps: {} }), t = Math.floor(Date.now() / 1000)
  const sig = `t=${t},v1=${createHmac('sha256', SK).update(`${t}.${body}`).digest('hex')}`
  const res = await fn(new Request('http://x/', { method: 'POST', body, headers: { 'x-stitchdb-job': sig } }))
  assert.deepEqual(await res.json(), { op: 'step', name: 'a', output: 2 })

  const calls = []
  const c = createClient(URL_, SK, { auth: { persistSession: false }, global: { fetch: async (url, opts) => { calls.push({ url: String(url), opts }); return new Response(JSON.stringify({ id: 'r9', status: 'queued', duplicate: false }), { status: 201 }) } } })
  const { data, error } = await c.jobs.start('onboarding', { user_id: 'u' }, { idempotencyKey: 'k1', delay: 5 })
  assert.equal(error, null); assert.equal(data.id, 'r9')
  assert.equal(calls[0].url, `${URL_}/jobs/v1/runs`)
  assert.deepEqual(JSON.parse(calls[0].opts.body), { job: 'onboarding', payload: { user_id: 'u' }, idempotency_key: 'k1', delay: 5 })
})

test('sql: tagged queries, fragments, identifiers, connection URL, transactions, errors', async () => {
  const { createSql, SqlError } = await import('../dist/sql.mjs')
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) })
    const b = JSON.parse(opts.body)
    if (b.query === 'bad') return new Response(JSON.stringify({ message: 'relation "x" does not exist', code: '42P01', position: '15' }), { status: 400 })
    if (b.transaction) return Response.json({ results: b.transaction.map((q, i) => ({ command: 'SELECT', rowCount: 1, fields: [], rows: [{ i }] })) })
    return Response.json({ command: 'SELECT', rowCount: 1, fields: [{ name: 'n', dataTypeID: 23 }], rows: [{ n: 1 }] })
  }
  const sql = createSql('https://sdb_sql_abcdefghijklmnopqrstuvwxyz@abcd.stitchdb.com', { fetch })
  const where = sql`owner = ${'ann'} and n > ${2}`
  const rows = await sql`select * from ${sql.identifier(['public', 'my"t'])} where id = ${7} and ${where} and at < ${new Date('2026-01-01T00:00:00Z')} and big = ${5n}`
  assert.deepEqual(rows, [{ n: 1 }])
  assert.equal(calls[0].url, 'https://abcd.stitchdb.com/sql/v1/query')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sdb_sql_abcdefghijklmnopqrstuvwxyz')
  assert.equal(calls[0].body.query, 'select * from "public"."my""t" where id = $1 and owner = $2 and n > $3 and at < $4 and big = $5')
  assert.deepEqual(calls[0].body.params, [7, 'ann', 2, '2026-01-01T00:00:00.000Z', '5'])
  const full = await sql.query('select $1', [1], { fullResults: true })
  assert.equal(full.command, 'SELECT')
  const [a, b] = await sql.transaction([sql`select 1`, sql`select 2`], { isolation: 'serializable' })
  assert.deepEqual([a, b], [[{ i: 0 }], [{ i: 1 }]])
  assert.equal(calls.at(-1).body.isolation, 'serializable')
  await assert.rejects(sql.query('bad'), (e) => e instanceof SqlError && e.code === '42P01' && e.status === 400 && e.position === '15')
  assert.throws(() => createSql('https://abcd.stitchdb.com'), /no SQL key/)
  const s2 = createSql({ url: 'https://abcd.stitchdb.com/', key: 'sdb_sql_k' }, { fetch })
  await s2`select 1`
  assert.equal(calls.at(-1).url, 'https://abcd.stitchdb.com/sql/v1/query')
})

test('collab: needs the yjs module, connects to /collab/v1/ws, syncs a document over the protocol', async () => {
  const { createClient } = await import('../dist/index.mjs')
  const c = createClient('https://abcd.stitchdb.com', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x')
  assert.throws(() => c.collab({}), /pass the yjs module/)
  const sent = []
  let sock
  class FakeWS { constructor(url) { this.url = url; sock = this; setTimeout(() => this.onopen(), 0) } send(m) { sent.push(JSON.parse(m)); const x = JSON.parse(m)
      if (x.t === 'auth') this.onmessage({ data: JSON.stringify({ t: 'ready', client: 'me' }) })
      if (x.t === 'join') this.onmessage({ data: JSON.stringify({ t: 'joined', doc: x.doc, write: true, seq: 3, count: 3, updates: ['AQID'], peers: [{ client: 'p2', state: { name: 'Bob' } }] }) })
      if (x.t === 'update') this.onmessage({ data: JSON.stringify({ t: 'ack', doc: x.doc, id: x.id, seq: 4 }) }) }
    close() {} }
  const applied = []
  const handlers = []
  const doc = { on: (e, f) => handlers.push(f), off: () => {} }
  const Y = { Doc: class {}, applyUpdate: (d, u, origin) => applied.push([...u]), encodeStateAsUpdate: () => new Uint8Array([9]), mergeUpdates: (us) => us[0] }
  const collab = c.collab({ Y, WebSocket: FakeWS })
  const room = await collab.open('doc-1', doc, { create: true })
  assert.equal(sock.url, 'wss://abcd.stitchdb.com/collab/v1/ws')
  assert.deepEqual(sent[0].t, 'auth')
  assert.deepEqual(sent[1], { t: 'join', doc: 'doc-1', since: 0, create: {} })
  assert.deepEqual(applied, [[1, 2, 3]])
  assert.equal(room.write, true); assert.equal(room.seq, 3); assert.deepEqual([...room.peers.values()], [{ name: 'Bob' }])
  handlers[0](new Uint8Array([7, 7]), 'local')
  assert.deepEqual(sent.at(-1), { t: 'update', doc: 'doc-1', data: 'Bwc=', id: 1 })
  assert.equal(room.unsaved, 0); assert.equal(room.seq, 4)
  room.setPresence({ cursor: 2 })
  assert.deepEqual(sent.at(-1), { t: 'presence', doc: 'doc-1', state: { cursor: 2 } })
  collab.close()
})

test('flags: load, get with defaults, change events, last values kept on errors', async () => {
  let answer = [200, { flags: { 'new-checkout': { value: true, variation: 0, reason: 'default' }, limit: { value: 25, variation: 1, reason: 'rule:0' } }, version: 3, user_id: null }]
  const { fetch, calls } = mockFetch((c) => (c.url.endsWith('/flags/v1/evaluate') ? answer : [404, {}]))
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  assert.equal(c.flags, c.flags, 'one flags client per StitchDB client')
  assert.equal(c.flags.get('new-checkout', false), false, 'the default before loading')
  const r = await c.flags.load({ attributes: { app_version: '2.4.1' }, refreshInterval: 0 })
  assert.equal(r.error, null)
  assert.equal(c.flags.isOn('new-checkout'), true)
  assert.equal(c.flags.get('limit', 10), 25)
  assert.equal(c.flags.get('missing', 'x'), 'x')
  assert.equal(c.flags.configVersion, 3)
  const body = JSON.parse(calls.at(-1).body)
  assert.deepEqual(body.attributes, { app_version: '2.4.1' }); assert.ok(body.anon_id)
  assert.equal(calls.at(-1).headers.get('apikey'), KEY)
  let changed = null
  const off = c.flags.on('change', (keys) => { changed = keys })
  answer = [200, { flags: { 'new-checkout': { value: false, variation: 1, reason: 'off' }, limit: { value: 25, variation: 1, reason: 'rule:0' } }, version: 4 }]
  await c.flags.refresh()
  assert.deepEqual(changed, ['new-checkout'])
  off()
  answer = [429, { message: 'used up' }]
  const e = await c.flags.refresh()
  assert.equal(e.error.status, 429)
  assert.equal(c.flags.get('limit', 10), 25, 'last values kept')
  c.flags.stop()
})

test('metering: record, recordMany, usage, customers, exportCsv', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.includes('/export')) return [200, 'customer,meter,period,value\nacme,ai_tokens,2026-10-25,1532\n']
    if (c.url.includes('/record')) return JSON.parse(c.body).meter === 'nope' ? [400, { message: 'There is no meter "nope"' }] : [200, { recorded: 1, duplicates: 0 }]
    return [200, { rows: [], meters: {}, customers: [] }]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  const r = await c.metering.record('ai_tokens', 1532, { customer: 'acme', idempotencyKey: 'cmpl-1', at: new Date('2026-10-25T10:00:00Z') })
  assert.deepEqual(r, { data: { recorded: 1, duplicates: 0 }, error: null })
  assert.equal(calls[0].url, `${URL_}/metering/v1/record`); assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { meter: 'ai_tokens', quantity: 1532, customer: 'acme', idempotency_key: 'cmpl-1', at: '2026-10-25T10:00:00.000Z' })
  await c.metering.recordMany([{ meter: 'seats', quantity: 4, customer: 'acme' }])
  assert.deepEqual(JSON.parse(calls[1].body), { events: [{ meter: 'seats', quantity: 4, customer: 'acme' }] })
  const bad = await c.metering.record('nope')
  assert.equal(bad.data, null); assert.equal(bad.error.status, 400); assert.match(bad.error.message, /no meter/)
  await c.metering.usage({ customer: 'acme', group: 'month', from: new Date('2026-10-01T00:00:00Z') })
  assert.equal(calls[3].url, `${URL_}/metering/v1/usage?customer=acme&group=month&from=2026-10-01T00%3A00%3A00.000Z`)
  await c.metering.customers({ limit: 5 })
  assert.equal(calls[4].url, `${URL_}/metering/v1/customers?limit=5`)
  const csv = await c.metering.exportCsv({ group: 'day' })
  assert.match(csv.data, /^customer,meter,period,value/); assert.match(calls[5].url, /\/export\?group=day&format=csv$/)
})

test('links: resolve, deferred, create, list, get, update, remove', async () => {
  const link = { code: 'aB3kP9x', url: 'https://go.shop.test/l/aB3kP9x', path: '/product/42', data: { promo: 'SPRING' } }
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.includes('/resolve/old')) return [410, { message: 'This link has expired', code: 'old' }]
    if (c.url.includes('/resolve/')) return [200, link]
    if (c.url.endsWith('/deferred')) return [200, { match: JSON.parse(c.body).platform === 'ios' ? { ...link, matched_by: 'network' } : null }]
    if (c.url.endsWith('/links') && c.method === 'POST') return [201, { ...link, ...JSON.parse(c.body) }]
    return [200, { links: [], total: 0 }]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  const { LinksClient } = await import('../dist/index.mjs')
  assert.equal(LinksClient.codeFrom('https://go.shop.test/l/aB3kP9x?utm=1'), 'aB3kP9x')
  assert.equal(LinksClient.codeFrom('https://go.shop.test/l/aB3kP9x/'), 'aB3kP9x')
  assert.equal(LinksClient.codeFrom('https://go.shop.test/product/42'), null)
  assert.equal(LinksClient.codeFrom('summer'), 'summer')
  let r = await c.links.resolve('https://go.shop.test/l/aB3kP9x', { platform: 'ios' })
  assert.deepEqual(r, { data: link, error: null })
  assert.equal(calls[0].url, `${URL_}/links/v1/resolve/aB3kP9x?platform=ios`)
  assert.equal(calls[0].headers.get('apikey'), KEY)
  r = await c.links.resolve('https://shop.test/about')
  assert.deepEqual(r, { data: null, error: null }); assert.equal(calls.length, 1, 'not a short link: no request')
  r = await c.links.resolve('old')
  assert.equal(r.error.status, 410)
  r = await c.links.deferred({ platform: 'ios' })
  assert.equal(r.data.matched_by, 'network')
  r = await c.links.deferred({ platform: 'android', referrer: 'stitch_link=x' })
  assert.equal(r.data, null); assert.deepEqual(JSON.parse(calls.at(-1).body), { platform: 'android', referrer: 'stitch_link=x' })
  r = await c.links.create({ path: '/invite/7', data: { from: 'ana' }, expires_at: new Date('2026-12-01T00:00:00Z') })
  assert.equal(r.data.path, '/invite/7'); assert.equal(JSON.parse(calls.at(-1).body).expires_at, '2026-12-01T00:00:00.000Z')
  await c.links.list({ search: 'spring', limit: 5 })
  assert.equal(calls.at(-1).url, `${URL_}/links/v1/links?q=spring&limit=5`)
  await c.links.get('summer', { days: 7 }); assert.equal(calls.at(-1).url, `${URL_}/links/v1/links/summer?days=7`)
  await c.links.update('summer', { disabled: true }); assert.equal(calls.at(-1).method, 'PATCH')
  await c.links.remove('summer'); assert.equal(calls.at(-1).method, 'DELETE')
})

test('auth.signInWithHostedPage: the page URL, PKCE code exchanged with the page', async () => {
  const { fetch, calls } = mockFetch((c) => c.url.endsWith('/login/v1/token')
    ? [200, { access_token: jwt({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'r1', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.c' } }]
    : [404, {}])
  const implicit = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  let r = await implicit.auth.signInWithHostedPage({ redirectTo: 'https://app.test/cb', view: 'sign-up', lang: 'de', skipBrowserRedirect: true })
  assert.equal(r.error, null)
  assert.equal(r.data.url, `${URL_}/login/v1/?redirect_to=https%3A%2F%2Fapp.test%2Fcb&view=sign-up&lang=de`)
  const storage = memoryStorage()
  const pkce = createClient(URL_, KEY, { auth: { flowType: 'pkce', storage, detectSessionInUrl: false, autoRefreshToken: false }, global: { fetch } })
  r = await pkce.auth.signInWithHostedPage({ redirectTo: 'https://app.test/cb', skipBrowserRedirect: true })
  const u = new URL(r.data.url)
  assert.match(u.searchParams.get('code_challenge'), /^[\w-]{43}$/)
  assert.equal(u.searchParams.get('code_challenge_method'), 's256')
  const ex = await pkce.auth.exchangeCodeForSession('sdbl_' + 'a'.repeat(43))
  assert.equal(ex.error, null); assert.equal(ex.data.session.user.id, 'u1')
  const call = calls.find((c) => c.url.endsWith('/login/v1/token'))
  const body = JSON.parse(call.body)
  assert.equal(body.code, 'sdbl_' + 'a'.repeat(43)); assert.match(body.code_verifier, /^[\w-]{43,128}$/)
})

test('sign-up sends the browser language as locale for e-mails in the user language', async () => {
  const bodies = []
  const fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 'u1', email: 'a@b.c' }), { status: 200 }) }
  const had = { window: globalThis.window, document: globalThis.document }
  globalThis.window = globalThis.window || {}; globalThis.document = globalThis.document || {}
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'de-DE' }, configurable: true })
  try {
    const c = createClient(URL_, KEY, { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    await c.auth.signUp({ email: 'a@b.c', password: 'secret-pass' })
    await c.auth.signUp({ email: 'a@b.c', password: 'secret-pass', options: { data: { language: 'fr', plan: 'x' } } })
    await c.auth.signInWithOtp({ email: 'a@b.c' })
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator
    if (had.window === undefined) delete globalThis.window
    if (had.document === undefined) delete globalThis.document
  }
  assert.deepEqual(bodies[0].data, { locale: 'de-DE' })
  assert.deepEqual(bodies[1].data, { language: 'fr', plan: 'x' })
  assert.deepEqual(bodies[2].data, { locale: 'de-DE' })
})

test('sign-up solves the project sign-up check when asked and sends the request again', async () => {
  const { createHash } = await import('node:crypto')
  const salt = 'abc?expires=9999999999&', n = 77
  const challenge = { algorithm: 'SHA-256', challenge: createHash('sha256').update(salt + n).digest('hex'), maxnumber: 200, salt, signature: 'sig' }
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null })
    if (String(url).endsWith('/challenge')) return new Response(JSON.stringify(challenge), { status: 200 })
    if (calls.filter((c) => c.method === 'POST').length === 1) return new Response(JSON.stringify({ code: 400, error_code: 'captcha_required', msg: 'Complete the sign-up check' }), { status: 400 })
    return new Response(JSON.stringify({ id: 'u1', email: 'a@b.c' }), { status: 200 })
  }
  const c = createClient(URL_, KEY, { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const { error } = await c.auth.signUp({ email: 'a@b.c', password: 'secret-pass' })
  assert.equal(error, null)
  assert.deepEqual(calls.map((x) => [x.method, x.url.split('/auth/v1')[1].split('?')[0]]), [['POST', '/signup'], ['GET', '/challenge'], ['POST', '/signup']])
  const answer = JSON.parse(Buffer.from(calls[2].body.stitchdb_captcha, 'base64').toString())
  assert.equal(answer.number, n); assert.equal(answer.signature, 'sig')
  // other errors are not retried
  calls.length = 0
  const f2 = async (url, opts) => { calls.push(String(url)); return new Response(JSON.stringify({ code: 400, error_code: 'email_address_invalid', msg: 'no' }), { status: 400 }) }
  const c2 = createClient(URL_, KEY, { global: { fetch: f2 }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const r2 = await c2.auth.signInWithOtp({ email: 'a@mailinator.com' })
  assert.equal(r2.error?.code, 'email_address_invalid'); assert.equal(calls.length, 1)
})

test('crashes: reports with API breadcrumbs, beforeSend, off for the project stops sending', async () => {
  let off = false
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.includes('/crashes/v1/')) return off ? [404, { message: 'crashes is not set up for this project' }] : [200, { received: 1 }]
    if (c.url.includes('/rest/v1/orders')) return [500, { code: 'PGRST116', message: 'boom' }]
    return [200, []]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  await c.from('orders').select('*').eq('id', 1)
  assert.equal(calls.length, 1, 'nothing recorded or sent before start()')
  c.crashes.start({ release: '1.4.0', captureUnhandled: false, beforeSend: (r) => (r.context.drop ? null : r) })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(calls.some((x) => x.url.endsWith('/crashes/v1/session')), 'a session for crash-free users')
  await c.from('orders').select('*').eq('id', 1)
  c.crashes.addBreadcrumb({ type: 'ui', message: 'tapped Pay' })
  c.crashes.captureException(new TypeError('total is undefined'), { context: { step: 'pay' } })
  await c.crashes.flush()
  const sent = calls.filter((x) => x.url.endsWith('/crashes/v1/report'))
  assert.equal(sent.length, 1)
  const [r] = JSON.parse(sent[0].body).reports
  assert.equal(r.exception.type, 'TypeError'); assert.equal(r.release, '1.4.0'); assert.equal(r.handled, true); assert.equal(r.platform, 'node')
  assert.match(r.exception.stack, /client\.test\.mjs/)
  const api = r.breadcrumbs.find((b) => b.type === 'api')
  assert.deepEqual([api.data.method, api.data.url, api.data.status, api.data.error_code], ['GET', '/rest/v1/orders?select&id', 500, 'PGRST116'], 'no query values')
  assert.equal(r.breadcrumbs.at(-1).message, 'tapped Pay')
  assert.ok(!r.breadcrumbs.some((b) => String(b.message).includes('/crashes/')), 'its own calls are not breadcrumbs')
  assert.ok(r.install_id)
  c.crashes.captureException(new Error('x'), { context: { drop: true } })
  await c.crashes.flush()
  assert.equal(calls.filter((x) => x.url.endsWith('/crashes/v1/report')).length, 1, 'beforeSend returned null')
  off = true
  c.crashes.captureException(new Error('a')); await c.crashes.flush()
  c.crashes.captureException(new Error('b')); await c.crashes.flush()
  assert.equal(calls.filter((x) => x.url.endsWith('/crashes/v1/report')).length, 2, 'after a 404 the client stops sending')
  c.crashes.stop()
})

test('analytics: queued before start, batched with the anonymous id, opt-out, off for the project stops sending', async () => {
  let off = false
  const { fetch, calls } = mockFetch((c) => {
    if (c.url.includes('/analytics/v1/')) return off ? [404, { message: 'analytics is not set up for this project' }] : [200, { received: 1 }]
    return [200, []]
  })
  const c = createClient(URL_, KEY, { auth: { persistSession: false }, global: { fetch } })
  c.analytics.track('app_open')
  c.analytics.track('bad name!')
  assert.equal(calls.length, 0, 'nothing sent before start()')
  c.analytics.start({ release: '2.0.0', flushIntervalMs: 60000, beforeSend: (e) => (e.props.secret ? null : e) })
  c.analytics.track('purchase', { plan: 'pro' })
  c.analytics.track('dropped', { secret: 1 })
  await c.analytics.flush()
  const sent = calls.filter((x) => x.url.endsWith('/analytics/v1/track'))
  assert.ok(sent.length >= 1)
  const all = sent.flatMap((x) => JSON.parse(x.body).events.map((e) => e.name))
  assert.deepEqual(all, ['app_open', 'purchase'], 'early events kept, invalid and beforeSend-null dropped')
  const b = JSON.parse(sent[0].body)
  assert.equal(b.anon_id, c.analytics.anonymousId); assert.equal(b.release, '2.0.0'); assert.equal(b.platform, 'node')
  await c.analytics.optOut()
  assert.ok(calls.some((x) => x.url.endsWith('/analytics/v1/opt-out') && x.method === 'POST'))
  c.analytics.track('after_optout'); await c.analytics.flush()
  assert.equal(calls.filter((x) => x.url.endsWith('/analytics/v1/track')).length, sent.length, 'opted out: nothing sent')
  await c.analytics.optIn()
  off = true
  c.analytics.track('a'); await c.analytics.flush()
  c.analytics.track('b'); await c.analytics.flush()
  assert.equal(calls.filter((x) => x.url.endsWith('/analytics/v1/track')).length, sent.length + 1, 'after a 404 the client stops sending')
  c.analytics.stop()
})
