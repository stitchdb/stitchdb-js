// Run after `npm run build`: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createClient, StitchClient, AuthError } from '../dist/index.mjs'

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
