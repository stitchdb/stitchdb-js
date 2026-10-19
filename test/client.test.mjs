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
  assert.match(calls[0].headers.get('x-client-info'), /^stitchdb-js\/2\.0\.0/)
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
