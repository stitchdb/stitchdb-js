// Run after `npm run build`: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  pipeline, defineMiddleware, HttpError, withCors, withClaims, withRequiredClaims, withStitchClient, withStitchAdminClient,
  withRequestId, withRateLimit, withOAuthProtectedResource, withPostgresClient, toNodeHandler,
} from '../dist/middleware.mjs'

const URL_ = 'https://abcdefghijklmnop.p.stitchdb.com'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const ANON = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon' })}.c2ln`
const SERVICE = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'stitchdb' })}.c2ln`
process.env.STITCHDB_URL = URL_
process.env.STITCHDB_ANON_KEY = ANON
process.env.STITCHDB_SERVICE_ROLE_KEY = SERVICE

const req = (path = '/', init = {}) => new Request(`https://fn.example${path}`, init)
const bearer = (t) => ({ headers: { Authorization: `Bearer ${t}` } })

// ES256 key + JWKS so getClaims() verifies locally; /auth/v1/.well-known/jwks.json is served by a mock fetch.
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }
async function sign(claims) {
  const h = b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' }), p = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}
const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const r = new Request(input, init)
  calls.push({ url: r.url, auth: r.headers.get('authorization'), apikey: r.headers.get('apikey') })
  if (r.url.endsWith('/auth/v1/.well-known/jwks.json')) return Response.json({ keys: [jwk] })
  if (r.url.includes('/rest/v1/')) return Response.json([{ id: 1 }])
  return realFetch(input, init)
}

test('pipeline: order, ctx, short-circuit, after hooks in reverse, errors as JSON', async () => {
  const log = []
  const a = defineMiddleware({ key: 'a', run: () => { log.push('a'); return 1 }, after: (res) => { log.push('a-after'); return new Response(res.body, { status: res.status, headers: { x: 'a' } }) } })
  const b = defineMiddleware({ key: 'b', requires: ['a'], run: (r, ctx) => { log.push('b'); return ctx.a + 1 }, after: () => { log.push('b-after') } })
  const h = pipeline([a, b], (r, ctx) => Response.json({ a: ctx.a, b: ctx.b }))
  const res = await h(req())
  assert.deepEqual(await res.json(), { a: 1, b: 2 })
  assert.equal(res.headers.get('x'), 'a')
  assert.deepEqual(log, ['a', 'b', 'b-after', 'a-after'])

  const stop = defineMiddleware({ key: 'stop', run: () => new Response('no', { status: 418 }), after: () => assert.fail('the middleware that answered has no after') })
  const r2 = await pipeline([a, stop], () => assert.fail('handler must not run'))(req())
  assert.equal(r2.status, 418); assert.equal(r2.headers.get('x'), 'a', 'earlier after hooks still run')

  const r3 = await pipeline([a], () => { throw new HttpError(404, 'No such todo') })(req())
  assert.equal(r3.status, 404); assert.deepEqual(await r3.json(), { code: 'not_found', message: 'No such todo' }); assert.equal(r3.headers.get('x'), 'a')
  const err = console.error; console.error = () => {}
  const r4 = await pipeline([], () => { throw new Error('secret detail') })(req())
  console.error = err
  assert.equal(r4.status, 500); assert.deepEqual(await r4.json(), { code: 'internal_error', message: 'Internal error' }, 'internal details are not leaked')

  assert.throws(() => pipeline([a, a], () => new Response()), /Duplicate middleware key "a"/)
  assert.throws(() => pipeline([b, a], () => new Response()), /"b" needs "a"/)
})

test('withCors: preflight, headers on success and errors, allow-list and credentials', async () => {
  const h = pipeline([withCors()], () => { throw new HttpError(400, 'bad') })
  const pre = await h(req('/', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } }))
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization.*apikey/)
  const bad = await h(req('/', { headers: { Origin: 'https://app.example' } }))
  assert.equal(bad.status, 400); assert.equal(bad.headers.get('access-control-allow-origin'), '*', 'error responses get CORS headers too')

  const only = pipeline([withCors({ origin: ['https://app.example'], credentials: true })], () => new Response('ok'))
  const ok = await only(req('/', { headers: { Origin: 'https://app.example' } }))
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true')
  assert.equal(ok.headers.get('vary'), 'Origin')
  const other = await only(req('/', { headers: { Origin: 'https://evil.example' } }))
  assert.equal(other.headers.get('access-control-allow-origin'), null)
  const otherPre = await only(req('/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }))
  assert.equal(otherPre.headers.get('access-control-allow-methods'), null)
})

test('withClaims + withRequiredClaims: anonymous, signed in, service role, invalid, roles', async () => {
  const h = pipeline([withClaims(), withRequiredClaims({ role: 'authenticated' })], (r, ctx) => Response.json({ sub: ctx.claims.sub }))
  const open = pipeline([withClaims()], (r, ctx) => Response.json({ claims: ctx.claims }))

  assert.deepEqual(await (await open(req())).json(), { claims: null }, 'no token: anonymous')
  assert.deepEqual(await (await open(req('/', bearer(ANON)))).json(), { claims: null }, 'anon key: anonymous')
  const svc = await (await open(req('/', bearer(SERVICE)))).json()
  assert.equal(svc.claims.role, 'service_role')

  const user = await sign({ sub: 'u1', role: 'authenticated' })
  const ok = await h(req('/', bearer(user)))
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { sub: 'u1' })
  assert.ok(calls.some((c) => c.url === `${URL_}/auth/v1/.well-known/jwks.json`), 'verified with the project JWKS')

  const bad = await h(req('/', bearer(user.slice(0, -4) + 'AAAA')))
  assert.equal(bad.status, 401); assert.equal((await bad.json()).code, 'invalid_token')
  const expired = await h(req('/', bearer(await sign({ sub: 'u1', role: 'authenticated', exp: 1 }))))
  assert.equal(expired.status, 401)
  assert.equal((await h(req())).status, 401, 'required: anonymous is 401')
  const svcOnly = await h(req('/', bearer(SERVICE)))
  assert.equal(svcOnly.status, 403, 'wrong role is 403')
  const pred = pipeline([withClaims(), withRequiredClaims((c) => c.sub === 'u2')], () => new Response('ok'))
  assert.equal((await pred(req('/', bearer(user)))).status, 403)
})

test('withStitchClient acts as the caller; withStitchAdminClient uses the service role', async () => {
  const user = await sign({ sub: 'u1', role: 'authenticated' })
  const h = pipeline([withStitchClient(), withStitchAdminClient()], async (r, ctx) => {
    await ctx.stitch.from('todos').select()
    await ctx.stitchAdmin.from('todos').select()
    return new Response('ok')
  })
  calls.length = 0
  await h(req('/', bearer(user)))
  const rest = calls.filter((c) => c.url.includes('/rest/v1/todos'))
  assert.equal(rest[0].auth, `Bearer ${user}`); assert.equal(rest[0].apikey, ANON)
  assert.equal(rest[1].auth, `Bearer ${SERVICE}`)
  calls.length = 0
  await h(req())
  assert.equal(calls.find((c) => c.url.includes('/rest/v1/todos')).auth, `Bearer ${ANON}`, 'anonymous caller uses the anon key')
})

test('settings: missing project URL is a clear 500; Workers env argument is used', async () => {
  const save = process.env.STITCHDB_URL
  delete process.env.STITCHDB_URL
  const h = pipeline([withStitchClient()], () => new Response('ok'))
  const r = await h(req())
  assert.equal(r.status, 500); assert.match((await r.json()).message, /STITCHDB_URL/)
  const w = await h(req(), { STITCHDB_URL: URL_ })
  assert.equal(w.status, 200)
  process.env.STITCHDB_URL = save
})

test('withRequestId, withRateLimit', async () => {
  const h = pipeline([withRequestId(), withRateLimit({ limit: 2, windowMs: 60_000 })], (r, ctx) => Response.json({ id: ctx.requestId, left: ctx.rateLimit.remaining }))
  const r1 = await h(req('/', { headers: { 'X-Request-Id': 'abc-1', 'X-Forwarded-For': '1.2.3.4' } }))
  assert.deepEqual(await r1.json(), { id: 'abc-1', left: 1 })
  assert.equal(r1.headers.get('x-request-id'), 'abc-1'); assert.equal(r1.headers.get('ratelimit-remaining'), '1')
  await h(req('/', { headers: { 'X-Forwarded-For': '1.2.3.4' } }))
  const r3 = await h(req('/', { headers: { 'X-Forwarded-For': '1.2.3.4' } }))
  assert.equal(r3.status, 429); assert.ok(Number(r3.headers.get('retry-after')) >= 1)
  assert.match(r3.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, 'new id when none sent')
  assert.equal((await h(req('/', { headers: { 'X-Forwarded-For': '5.6.7.8' } }))).status, 200, 'other callers have their own count')
  assert.equal((await h(req('/', { headers: { 'X-Request-Id': 'bad id <script>' } }))).headers.get('x-request-id').length, 36)
})

test('withOAuthProtectedResource: metadata document and 401 challenge', async () => {
  const resource = `${URL_}/functions/v1/mcp`
  const h = pipeline([withOAuthProtectedResource({ resource, scopes: ['openid'] }), withClaims(), withRequiredClaims()], () => new Response('ok'))
  const meta = await h(new Request(`${resource}/.well-known/oauth-protected-resource`))
  assert.deepEqual(await meta.json(), { resource, authorization_servers: [`${URL_}/auth/v1`], bearer_methods_supported: ['header'], scopes_supported: ['openid'] })
  const r = await h(new Request(resource, { method: 'POST' }))
  assert.equal(r.status, 401)
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`)
})

test('withPostgresClient sets the role and claims in a transaction', async () => {
  const sent = []
  const tag = (strings, ...values) => { sent.push({ text: strings.join('$'), values }); return Promise.resolve([{ ok: 1 }]) }
  const sql = Object.assign(tag, { begin: async (fn) => { sent.push('begin'); const out = await fn(tag); sent.push('commit'); return out } })
  const user = await sign({ sub: 'u1', role: 'authenticated' })
  const h = pipeline([withClaims(), withPostgresClient({ sql })], async (r, ctx) => Response.json(await ctx.pg.transaction((tx) => tx`select 1`)))
  await h(req('/', bearer(user)))
  assert.equal(sent[0], 'begin'); assert.equal(sent.at(-1), 'commit')
  assert.match(sent[1].text, /set_config\('role'/)
  assert.equal(sent[1].values[0], 'authenticated'); assert.equal(JSON.parse(sent[1].values[1]).sub, 'u1')
  sent.length = 0
  await h(req())
  assert.equal(sent[1].values[0], 'anon')
  assert.throws(() => pipeline([withPostgresClient({ sql })], () => new Response()), /needs "claims"/)
})

test('toNodeHandler serves a pipeline over node:http', async () => {
  const h = pipeline([withCors()], async (r) => Response.json({ method: r.method, body: await r.text() }, { headers: { 'Set-Cookie': 'a=1' } }))
  const server = http.createServer(toNodeHandler(h))
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/x`, { method: 'POST', body: 'hello' })
    assert.deepEqual(await res.json(), { method: 'POST', body: 'hello' })
    assert.equal(res.headers.get('access-control-allow-origin'), '*'); assert.equal(res.headers.get('set-cookie'), 'a=1')
  } finally { server.close() }
})
