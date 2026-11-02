// Run after `npm run build`: node --test test/
// GraphQL, analytics and crash reports (service key), job monitoring, metering extras, status page, collab over HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, GraphQLError, HeartbeatClient, HeartbeatError, CrashesError, AnalyticsError, StatusError } from '../dist/index.mjs'

const URL_ = 'https://abcdefghijklmnop.stitchdb.com'
const KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln'
const TOKEN = 'hb_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'

function mockFetch(route) {
  const calls = []
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined))
    const call = { url, method: init.method || 'GET', headers, body: init.body }
    calls.push(call)
    const [status, body, extra] = route(call) || [200, {}]
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(extra || {}) } })
  }
  return { fetch, calls }
}
const client = (route) => {
  const m = mockFetch(route)
  return { c: createClient(URL_, KEY, { global: { fetch: m.fetch }, auth: { persistSession: false } }), calls: m.calls }
}

test('graphql: POST /graphql/v1 with query, variables and operationName; data and errors', async () => {
  const { c, calls } = client((call) => {
    const b = JSON.parse(call.body)
    if (b.query.includes('broken')) return [200, { data: null, errors: [{ message: 'Unknown field "broken"' }] }]
    return [200, { data: { todosCollection: { edges: [{ node: { id: 1 } }] } } }]
  })
  const r = await c.graphql('query T($n: Int) { todosCollection(first: $n) { edges { node { id } } } }', { variables: { n: 5 }, operationName: 'T', headers: { 'X-Test': '1' } })
  assert.equal(r.error, null); assert.equal(r.data.todosCollection.edges[0].node.id, 1); assert.equal(r.errors, undefined)
  assert.equal(calls[0].url, `${URL_}/graphql/v1`); assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { query: 'query T($n: Int) { todosCollection(first: $n) { edges { node { id } } } }', variables: { n: 5 }, operationName: 'T' })
  assert.equal(calls[0].headers.get('apikey'), KEY); assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`)
  assert.equal(calls[0].headers.get('content-type'), 'application/json'); assert.equal(calls[0].headers.get('x-test'), '1')
  const bad = await c.graphql('{ broken }')
  assert.ok(bad.error instanceof GraphQLError); assert.match(bad.error.message, /Unknown field/); assert.equal(bad.errors.length, 1)
  assert.deepEqual(JSON.parse(calls[1].body), { query: '{ broken }', variables: {} })
  const { c: off } = client(() => [404, { message: 'Not found' }])
  const r404 = await off.graphql('{ x }')
  assert.equal(r404.error.status, 404); assert.equal(r404.data, null)
})

test('analytics reports: overview, trend, funnel, retention, user (service key)', async () => {
  const { c, calls } = client((call) => (call.url.includes('/retention') ? [403, { message: 'Use the service key' }] : [200, { ok: 1 }]))
  let r = await c.analytics.overview({ days: 7 })
  assert.equal(r.error, null); assert.equal(calls[0].url, `${URL_}/analytics/v1/overview?days=7`); assert.equal(calls[0].method, 'GET')
  await c.analytics.trend({ event: 'purchase', from: new Date('2026-10-01T00:00:00Z'), interval: 'week', measure: 'users', breakdown: 'plan' })
  assert.equal(calls[1].url, `${URL_}/analytics/v1/trend?event=purchase&from=2026-10-01T00%3A00%3A00.000Z&interval=week&measure=users&breakdown=plan`)
  await c.analytics.funnel(['signup', 'purchase'], { windowHours: 72, to: '2026-11-01' })
  assert.equal(calls[2].url, `${URL_}/analytics/v1/funnel`); assert.equal(calls[2].method, 'POST')
  assert.deepEqual(JSON.parse(calls[2].body), { steps: ['signup', 'purchase'], to: '2026-11-01', window_hours: 72 })
  r = await c.analytics.retention({ weeks: 4 })
  assert.ok(r.error instanceof AnalyticsError); assert.equal(r.error.status, 403); assert.equal(calls[3].url, `${URL_}/analytics/v1/retention?weeks=4`)
  await c.analytics.user({ userId: 'u1', limit: 20 })
  assert.equal(calls[4].url, `${URL_}/analytics/v1/user?user_id=u1&limit=20`)
  await c.analytics.user({ anonId: 'dev-1' })
  assert.equal(calls[5].url, `${URL_}/analytics/v1/user?anon_id=dev-1`)
})

test('crash reports: issues, issue, updateIssue, releases, sourcemaps', async () => {
  const { c, calls } = client((call) => {
    if (call.url.includes('/issues/404')) return [404, { message: 'No such issue' }]
    if (call.url.includes('/sourcemaps') && call.method === 'POST') return [200, { id: 1, release: '1.4.0', name: '/assets/app.js', size: 10, used_bytes: 10, limit_bytes: 50 }]
    return [200, { issues: [], total: 0 }]
  })
  await c.crashes.issues({ status: 'all', release: '1.4.0', search: 'TypeError', limit: 10, offset: 20 })
  assert.equal(calls[0].url, `${URL_}/crashes/v1/issues?status=all&release=1.4.0&q=TypeError&limit=10&offset=20`)
  await c.crashes.issue(7)
  assert.equal(calls[1].url, `${URL_}/crashes/v1/issues/7`)
  const nf = await c.crashes.issue(404)
  assert.ok(nf.error instanceof CrashesError); assert.equal(nf.error.status, 404)
  await c.crashes.updateIssue(7, { status: 'resolved' })
  assert.equal(calls[3].method, 'PATCH'); assert.deepEqual(JSON.parse(calls[3].body), { status: 'resolved' })
  await c.crashes.releases({ days: 14 })
  assert.equal(calls[4].url, `${URL_}/crashes/v1/releases?days=14`)
  const map = '{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}'
  const up = await c.crashes.sourcemaps.upload({ release: '1.4.0', name: '/assets/app.js', map })
  assert.equal(up.error, null); assert.equal(up.data.name, '/assets/app.js')
  assert.equal(calls[5].url, `${URL_}/crashes/v1/sourcemaps?release=1.4.0&name=%2Fassets%2Fapp.js`); assert.equal(calls[5].method, 'POST'); assert.equal(calls[5].body, map)
  await c.crashes.sourcemaps.upload({ release: '1.4.0', map: JSON.parse(map) })
  assert.equal(calls[6].body, map); assert.equal(calls[6].url, `${URL_}/crashes/v1/sourcemaps?release=1.4.0`)
  const bytes = new Uint8Array([0x1f, 0x8b, 8])
  await c.crashes.sourcemaps.upload({ release: '1.4.0', name: 'app.js', map: bytes })
  assert.equal(calls[7].body, bytes)
  await c.crashes.sourcemaps.list({ release: '1.4.0' })
  assert.equal(calls[8].url, `${URL_}/crashes/v1/sourcemaps?release=1.4.0`); assert.equal(calls[8].method, 'GET')
  await c.crashes.sourcemaps.remove({ release: '1.4.0', name: '/assets/app.js' })
  assert.equal(calls[9].url, `${URL_}/crashes/v1/sourcemaps?release=1.4.0&name=%2Fassets%2Fapp.js`); assert.equal(calls[9].method, 'DELETE')
})

test('heartbeat: ping URLs, run(), monitors', async () => {
  const { c, calls } = client((call) => {
    if (call.url.endsWith('/monitors')) return [200, { monitors: [{ id: 1, name: 'nightly' }] }]
    if (call.url.includes('/monitors/')) return [200, { monitor: { id: 1 }, runs: [] }]
    return [200, { ok: true }]
  })
  const base = `${URL_}/heartbeat/v1/${TOKEN}`
  assert.equal(HeartbeatClient.tokenFrom(`${base}/start`), TOKEN); assert.equal(HeartbeatClient.tokenFrom('nope'), null)
  assert.equal(c.heartbeat.pingUrl(TOKEN, { exitCode: 2 }), `${base}/2`)
  let r = await c.heartbeat.ping(TOKEN)
  assert.equal(r.error, null); assert.equal(calls[0].url, base); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body, '')
  await c.heartbeat.ping(base, { status: 'start' })
  assert.equal(calls[1].url, `${base}/start`)
  await c.heartbeat.ping(TOKEN, { status: 'fail', message: 'disk full' })
  assert.equal(calls[2].url, `${base}/fail`); assert.equal(calls[2].body, 'disk full')
  await c.heartbeat.ping(TOKEN, { exitCode: 0 })
  assert.equal(calls[3].url, `${base}/0`)
  r = await c.heartbeat.ping('hb_short')
  assert.ok(r.error instanceof HeartbeatError); assert.equal(calls.length, 4)
  r = await c.heartbeat.ping(TOKEN, { exitCode: 300 })
  assert.match(r.error.message, /0 to 255/)
  assert.equal(await c.heartbeat.run(TOKEN, async () => 42), 42)
  assert.deepEqual(calls.slice(4).map((x) => x.url), [`${base}/start`, base])
  await assert.rejects(c.heartbeat.run(TOKEN, () => { throw new Error('boom') }), /boom/)
  assert.equal(calls.at(-1).url, `${base}/fail`); assert.match(calls.at(-1).body, /boom/)
  const m = await c.heartbeat.monitors()
  assert.equal(m.data[0].name, 'nightly'); assert.equal(calls.at(-1).url, `${URL_}/heartbeat/v1/monitors`)
  await c.heartbeat.monitor(1, { limit: 50 })
  assert.equal(calls.at(-1).url, `${URL_}/heartbeat/v1/monitors/1?limit=50`)
})

test('metering: exportRows, Stripe customers, alerts', async () => {
  const { c, calls } = client((call) => {
    if (call.url.includes('/stripe-customers') && call.method === 'GET') return [200, { customers: [{ customer: 'acme', stripe_customer_id: 'cus_1' }] }]
    if (call.url.includes('/alerts')) return [200, { alerts: [{ alert_id: 'a1', customer: 'acme' }] }]
    return [200, { saved: 1, removed: 0, rows: [] }]
  })
  await c.metering.exportRows({ group: 'month' })
  assert.equal(calls[0].url, `${URL_}/metering/v1/export?group=month&format=json`)
  await c.metering.setStripeCustomer('acme', 'cus_1')
  assert.equal(calls[1].url, `${URL_}/metering/v1/stripe-customers`); assert.equal(calls[1].method, 'PUT')
  assert.deepEqual(JSON.parse(calls[1].body), { customer: 'acme', stripe_customer_id: 'cus_1' })
  await c.metering.setStripeCustomers([{ customer: 'acme', stripeCustomerId: 'cus_1' }, { customer: 'old', stripeCustomerId: null }])
  assert.deepEqual(JSON.parse(calls[2].body), { customers: [{ customer: 'acme', stripe_customer_id: 'cus_1' }, { customer: 'old', stripe_customer_id: null }] })
  const list = await c.metering.stripeCustomers({ customer: 'acme' })
  assert.equal(list.data[0].stripe_customer_id, 'cus_1'); assert.equal(calls[3].url, `${URL_}/metering/v1/stripe-customers?customer=acme`); assert.equal(calls[3].method, 'GET')
  const al = await c.metering.alerts({ month: '2026-10', limit: 5 })
  assert.equal(al.data[0].alert_id, 'a1'); assert.equal(calls[4].url, `${URL_}/metering/v1/alerts?month=2026-10&limit=5`)
})

test('status page: get, subscribe, URLs', async () => {
  const { c, calls } = client((call) => {
    if (call.url.endsWith('/status.json')) return [200, { title: 'Shop status', overall: 'operational', components: [], incidents: [] }]
    const b = JSON.parse(call.body)
    return b.email === 'bad' ? [400, { message: 'Enter a valid e-mail address.' }] : [200, { ok: true, message: 'We sent a link' }]
  })
  const s = await c.status.get()
  assert.equal(s.data.overall, 'operational'); assert.equal(calls[0].url, `${URL_}/status/v1/status.json`); assert.equal(calls[0].method, 'GET')
  const sub = await c.status.subscribe('ana@example.com')
  assert.equal(sub.data.ok, true); assert.equal(calls[1].url, `${URL_}/status/v1/subscribe`); assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].headers.get('content-type'), 'application/json'); assert.deepEqual(JSON.parse(calls[1].body), { email: 'ana@example.com' })
  const bad = await c.status.subscribe('bad')
  assert.ok(bad.error instanceof StatusError); assert.equal(bad.error.status, 400)
  assert.equal(c.status.pageUrl(), `${URL_}/status/v1/`)
  assert.equal(c.status.jsonUrl(), `${URL_}/status/v1/status.json`)
  assert.equal(c.status.badgeUrl({ component: 'api', label: 'API' }), `${URL_}/status/v1/badge.svg?component=api&label=API`)
  assert.equal(c.status.badgeUrl(), `${URL_}/status/v1/badge.svg`)
})

test('collab over HTTP: load and write without a live connection', async () => {
  const applied = []
  const Y = { Doc: class { on() {} off() {} }, applyUpdate: (d, u) => applied.push([d, [...u]]), encodeStateAsUpdate: () => new Uint8Array(), mergeUpdates: (u) => u[0] }
  const { c, calls } = client((call) => (call.method === 'POST' ? [201, { seq: 5 }] : [200, { id: 'plan', seq: 4, size: 6, updates: [Buffer.from([1, 2, 3]).toString('base64'), Buffer.from([4]).toString('base64')] }]))
  const collab = c.collab({ Y, WebSocket: class {} })
  const r = await collab.load('plan', { since: 2 })
  assert.equal(calls[0].url, `${URL_}/collab/v1/docs/plan?since=2`); assert.equal(calls[0].headers.get('apikey'), KEY)
  assert.equal(r.seq, 4); assert.deepEqual(applied.map((a) => a[1]), [[1, 2, 3], [4]]); assert.ok(applied.every((a) => a[0] === r.doc))
  assert.equal(await collab.write('plan', new Uint8Array([9, 9])), 5)
  assert.equal(calls[1].url, `${URL_}/collab/v1/docs/plan/updates`); assert.equal(calls[1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].body), { data: Buffer.from([9, 9]).toString('base64') })
})
