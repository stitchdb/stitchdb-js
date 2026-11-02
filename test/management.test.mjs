// Run after `npm run build`: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createManagementClient, createAgentClient, ManagementClient, ManagementError } from '../dist/management.mjs'

const API = 'https://api.example.test'
const BASE = `${API}/platform/v1`
const TOKEN = 'sdb_pat_test_0000000000000000'
const REF = 'abcdefghijklmnop'
const ORG = '11111111-2222-3333-4444-555555555555'
const ID = '99999999-8888-7777-6666-555555555555'

// A fetch that records requests and answers from a routing function: [status, body, headers].
function mockFetch(route = () => [200, {}]) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: new Headers(init.headers), body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    const [status, body, extra] = route(call, calls.length) || [200, {}]
    const isText = typeof body === 'string'
    return new Response(isText ? body : JSON.stringify(body), { status, headers: { 'content-type': isText ? 'text/plain' : 'application/json', ...(extra || {}) } })
  }
  return { fetch, calls }
}
const client = (route) => { const m = mockFetch(route); return { mgmt: createManagementClient({ accessToken: TOKEN, apiUrl: API, fetch: m.fetch }), calls: m.calls } }
const path = (c) => { const u = new URL(c.url); return u.pathname.replace('/platform/v1', '') + u.search }

test('entry: exports, package.json export map, defaults', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(pkg.exports['./management'].import, './dist/management.mjs')
  const cjs = createRequire(import.meta.url)('../dist/management.cjs')
  assert.equal(typeof cjs.createManagementClient, 'function'); assert.equal(typeof cjs.createAgentClient, 'function')
  const self = await import('../dist/stitchdb-management.mjs')
  assert.equal(typeof self.createManagementClient, 'function')
  assert.throws(() => createManagementClient({}), /access token is required/)
  const { fetch, calls } = mockFetch(() => [200, []])
  const m = createManagementClient({ accessToken: TOKEN, fetch })
  assert.ok(m instanceof ManagementClient)
  await m.projects.list()
  assert.equal(calls[0].url, 'https://stitchdb.com/platform/v1/projects')
})

test('headers and the { data, error } result', async () => {
  const { mgmt, calls } = client(() => [200, [{ ref: REF, name: 'shop' }], { 'x-next-cursor': 'abc' }])
  const r = await mgmt.projects.list({ organization_id: ORG, label: ['env:prod', 'team:a'], include_branches: false, limit: 10 })
  assert.equal(r.error, null); assert.equal(r.status, 200); assert.equal(r.nextCursor, 'abc')
  assert.deepEqual(r.data, [{ ref: REF, name: 'shop' }])
  const c = calls[0], u = new URL(c.url)
  assert.equal(c.method, 'GET'); assert.equal(u.origin + u.pathname, `${BASE}/projects`)
  assert.deepEqual(u.searchParams.getAll('label'), ['env:prod', 'team:a'])
  assert.equal(u.searchParams.get('include_branches'), 'false'); assert.equal(u.searchParams.get('limit'), '10')
  assert.equal(c.headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.equal(c.headers.get('accept'), 'application/json')
  assert.match(c.headers.get('x-client-info'), /^stitchdb-js\/\d+\.\d+\.\d+/)
  assert.equal(c.headers.get('content-type'), null, 'no content type without a body')
})

test('projects', async () => {
  const { mgmt, calls } = client(() => [200, { ref: REF }])
  await mgmt.projects.create({ name: 'shop', region: 'eu', labels: { env: 'dev' } }, { idempotencyKey: 'k1' })
  await mgmt.projects.update(REF, { labels: { env: null } })
  await mgmt.projects.delete(REF)
  await mgmt.projects.pause(REF)
  await mgmt.projects.rotateKeys(REF, { grace_seconds: 60 })
  await mgmt.projects.updateLimits(REF, { api_rps: 50 })
  await mgmt.projects.usage(REF, { from: '2026-10-01', to: '2026-10-31' })
  await mgmt.projects.metrics(REF, { range: '7d' })
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    'POST /projects', `PATCH /projects/${REF}`, `DELETE /projects/${REF}`, `POST /projects/${REF}/pause`, `POST /projects/${REF}/api-keys/rotate`,
    `PATCH /projects/${REF}/limits`, `GET /projects/${REF}/usage?from=2026-10-01&to=2026-10-31`, `GET /projects/${REF}/metrics?range=7d`,
  ])
  assert.deepEqual(calls[0].body, { name: 'shop', region: 'eu', labels: { env: 'dev' } })
  assert.equal(calls[0].headers.get('idempotency-key'), 'k1'); assert.equal(calls[0].headers.get('content-type'), 'application/json')
  assert.deepEqual(calls[1].body, { labels: { env: null } })
  assert.deepEqual(calls[4].body, { grace_seconds: 60 })
})

test('database, migrations, branches', async () => {
  const { mgmt, calls } = client((c) => (c.url.includes('/dump') ? [200, '-- schema\ncreate table t();'] : [200, { rows: [], results: [] }]))
  await mgmt.database.query(REF, 'select 1')
  await mgmt.database.query(REF, { query: 'select 2', read_only: true })
  const dump = await mgmt.database.dump(REF, { schemas: ['public', 'app'], dataOnly: true })
  assert.equal(dump.data, '-- schema\ncreate table t();')
  await mgmt.database.types(REF, 'kotlin', { package: 'com.app' })
  await mgmt.database.advisors(REF, 'security')
  await mgmt.database.queryPerformance(REF, { sort: 'mean', limit: 5 })
  await mgmt.migrations.apply(REF, [{ version: '20261101000000', name: 'init', sql: 'create table a()' }], { dryRun: true })
  await mgmt.migrations.list(REF, { includeSql: true })
  await mgmt.branches.create(REF, { name: 'feature/x' })
  await mgmt.branches.merge('qrstuvwxyzabcdef', { dry_run: true })
  await mgmt.branches.delete('qrstuvwxyzabcdef')
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    `POST /projects/${REF}/database/query`, `POST /projects/${REF}/database/query`, `GET /projects/${REF}/database/dump?schemas=public%2Capp&data_only=1`,
    `GET /projects/${REF}/types/kotlin?package=com.app`, `GET /projects/${REF}/advisors/security`, `GET /projects/${REF}/database/query-performance?sort=mean&limit=5`,
    `POST /projects/${REF}/migrations`, `GET /projects/${REF}/migrations?include_sql=1`, `POST /projects/${REF}/branches`,
    'POST /branches/qrstuvwxyzabcdef/merge', 'DELETE /branches/qrstuvwxyzabcdef',
  ])
  assert.deepEqual(calls[0].body, { query: 'select 1' })
  assert.deepEqual(calls[1].body, { query: 'select 2', read_only: true })
  assert.deepEqual(calls[6].body, { migrations: [{ version: '20261101000000', name: 'init', sql: 'create table a()' }], dry_run: true })
})

test('functions and secrets: files are sent as utf8 text or base64', async () => {
  const { mgmt, calls } = client(() => [200, {}])
  await mgmt.functions.deploy(REF, { slug: 'hello', verify_jwt: false, files: [{ name: 'index.ts', content: 'Deno.serve(() => new Response("hi"))' }, { name: 'logo.png', content: new Uint8Array([137, 80, 78, 71]) }] })
  await mgmt.functions.logs(REF, null, { limit: 20 })
  await mgmt.functions.logs(REF, 'hello', { level: 'error' })
  await mgmt.functions.update(REF, 'hello', { version: 3 })
  await mgmt.secrets.set(REF, { STRIPE_KEY: 'x' })
  await mgmt.secrets.delete(REF, ['STRIPE_KEY'])
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    `POST /projects/${REF}/functions`, `GET /projects/${REF}/functions/logs?limit=20`, `GET /projects/${REF}/functions/hello/logs?level=error`,
    `PATCH /projects/${REF}/functions/hello`, `POST /projects/${REF}/secrets`, `DELETE /projects/${REF}/secrets`,
  ])
  assert.deepEqual(calls[0].body.files, [{ name: 'index.ts', content: 'Deno.serve(() => new Response("hi"))', encoding: 'utf8' }, { name: 'logo.png', content: 'iVBORw==' }])
  assert.equal(calls[0].body.slug, 'hello'); assert.equal(calls[0].body.verify_jwt, false)
  assert.deepEqual(calls[4].body, { STRIPE_KEY: 'x' }); assert.deepEqual(calls[5].body, { names: ['STRIPE_KEY'] })
})

test('webhooks, log drains, logs, domains, integrations', async () => {
  const { mgmt, calls } = client(() => [200, {}])
  await mgmt.webhooks.create(REF, { url: 'https://hooks.example.test/x', tables: ['orders'] })
  await mgmt.webhooks.deliveries(REF, ID, { status: 'dead', limit: 10 })
  await mgmt.webhooks.replay(REF, ID, { status: 'dead' })
  await mgmt.logDrains.test(REF, ID)
  await mgmt.logs.search(REF, { source: 'api', q: 'timeout', limit: 50 })
  await mgmt.logs.query(REF, 'select count(*) from api', { since: '1h' })
  await mgmt.domains.add(REF, 'api.example.test')
  await mgmt.domains.update(REF, 'api.example.test', { use_for_auth: true })
  await mgmt.integrations.vercel.unlink(REF, ID, { removeVariables: true })
  await mgmt.integrations.github.link(REF, { installation_id: 1, repo_id: 2 })
  await mgmt.integrations.github.repositories(REF, 1)
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    `POST /projects/${REF}/webhooks`, `GET /projects/${REF}/webhooks/${ID}/deliveries?status=dead&limit=10`, `POST /projects/${REF}/webhooks/${ID}/replay`,
    `POST /projects/${REF}/log-drains/${ID}/test`, `GET /projects/${REF}/logs?source=api&q=timeout&limit=50`, `POST /projects/${REF}/logs/query`,
    `POST /projects/${REF}/custom-domains`, `PUT /projects/${REF}/custom-domains/api.example.test`, `DELETE /projects/${REF}/integrations/vercel/${ID}?remove_variables=true`,
    `PUT /projects/${REF}/integrations/github`, `GET /projects/${REF}/integrations/github/repositories?installation_id=1`,
  ])
  assert.deepEqual(calls[5].body, { query: 'select count(*) from api', since: '1h' })
  assert.deepEqual(calls[6].body, { domain: 'api.example.test' })
  assert.deepEqual(calls[9].body, { installation_id: 1, repo_id: 2 })
})

test('organizations', async () => {
  const { mgmt, calls } = client(() => [200, {}])
  await mgmt.organizations.list()
  await mgmt.organizations.billing(ORG)
  await mgmt.organizations.auditLog(ORG, { action: 'project', limit: 20 })
  await mgmt.organizations.members.update(ORG, ID, { role: 'developer', project_refs: [REF] })
  await mgmt.organizations.invitations.create(ORG, { email: 'a@example.test', role: 'read_only' })
  await mgmt.organizations.tokens.create(ORG, { name: 'ci', scopes: ['projects:read'] })
  await mgmt.organizations.apps.disconnect(ORG, ID)
  await mgmt.organizations.webhooks.redeliver(ORG, ID, 'd1')
  await mgmt.organizations.usage(ORG, { from: '2026-10-01' })
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    'GET /organizations', `GET /organizations/${ORG}/billing`, `GET /organizations/${ORG}/audit-log?action=project&limit=20`,
    `PATCH /organizations/${ORG}/members/${ID}`, `POST /organizations/${ORG}/invitations`, `POST /organizations/${ORG}/tokens`,
    `DELETE /organizations/${ORG}/apps/${ID}`, `POST /organizations/${ORG}/webhooks/${ID}/deliveries/d1/redeliver`, `GET /organizations/${ORG}/usage?from=2026-10-01`,
  ])
  assert.deepEqual(calls[3].body, { role: 'developer', project_refs: [REF] })
  assert.deepEqual(calls[5].body, { name: 'ci', scopes: ['projects:read'] })
})

test('project settings: tokens, claim links, auth, graphql, network, region move, security, imports, billing', async () => {
  const { mgmt, calls } = client(() => [200, {}])
  await mgmt.tokens.create(REF, { expires_in: 600 })
  await mgmt.tokens.revoke(REF, ID)
  await mgmt.claimLinks.create(REF, { expires_in_days: 7 })
  await mgmt.authConfig.update(REF, { site_url: 'https://app.example.test' })
  await mgmt.graphql.set(REF, true)
  await mgmt.networkRestrictions.set(REF, ['203.0.113.0/24'])
  await mgmt.regionMove.start(REF, { region: 'us-east', when: 'quiet' })
  await mgmt.security.exposure(REF, { fresh: true })
  await mgmt.security.updateSettings(REF, { enforce: 'warn' })
  await mgmt.imports.start(REF, { source_uri: 'postgres://u:p@db.example.test/app', mode: 'dump' })
  await mgmt.imports.undo(REF, { confirm: 'shop' })
  await mgmt.billing.estimate({ project_ref: REF, change: { plan: 'pro' } })
  await mgmt.openapi()
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    `POST /projects/${REF}/tokens`, `DELETE /projects/${REF}/tokens/${ID}`, `POST /projects/${REF}/claim-links`, `PATCH /projects/${REF}/config/auth`,
    `PUT /projects/${REF}/graphql`, `PUT /projects/${REF}/network-restrictions`, `POST /projects/${REF}/region-move`, `GET /projects/${REF}/security/exposure?fresh=1`,
    `PATCH /projects/${REF}/security/settings`, `POST /projects/${REF}/import`, `POST /projects/${REF}/import/undo`, 'POST /billing/estimate', 'GET /openapi.json',
  ])
  assert.deepEqual(calls[4].body, { enabled: true })
  assert.deepEqual(calls[5].body, { allowlist: ['203.0.113.0/24'] })
  assert.deepEqual(calls[10].body, { confirm: 'shop' })
  assert.deepEqual(calls[11].body, { project_ref: REF, change: { plan: 'pro' } })
})

test('agent management routes', async () => {
  const { mgmt, calls } = client(() => [200, {}])
  await mgmt.agents.keys.create(REF, { name: 'bot', preset: 'read-only' })
  await mgmt.agents.dbLogins.create(REF, ID, { ttl_minutes: 15 })
  await mgmt.agents.audit(REF, { limit: 5 })
  await mgmt.agents.approvals.approve(REF, ID, { note: 'ok' })
  await mgmt.agents.sessions.revert(REF, 'run:42', { dry_run: false })
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), [
    `POST /projects/${REF}/agent-keys`, `POST /projects/${REF}/agent-keys/${ID}/db-logins`, `GET /projects/${REF}/agent-audit?limit=5`,
    `POST /projects/${REF}/agent-approvals/${ID}/approve`, `POST /projects/${REF}/agent-sessions/run%3A42/revert`,
  ])
  assert.deepEqual(calls[4].body, { dry_run: false })
})

test('agent client: key, session header, pending approval', async () => {
  const { fetch, calls } = mockFetch((c) => (c.url.endsWith('/agent/sql') ? [202, { status: 'pending_approval', approval_id: ID }] : [200, { agent: 'bot' }]))
  const agent = createAgentClient({ agentKey: 'sdb_agt_test', apiUrl: API, fetch })
  const who = await agent.whoami()
  assert.equal(who.data.agent, 'bot')
  const r = await agent.sql('delete from t', { session: 's1' })
  assert.equal(r.error, null); assert.equal(r.status, 202); assert.equal(r.data.status, 'pending_approval')
  await agent.dbCredentials({ ttl_minutes: 10 })
  await agent.approval(ID)
  await agent.revert('s1', { dry_run: true })
  assert.deepEqual(calls.map((c) => `${c.method} ${path(c)}`), ['GET /agent', 'POST /agent/sql', 'POST /agent/db-credentials', `GET /agent/approvals/${ID}`, 'POST /agent/sessions/s1/revert'])
  assert.equal(calls[1].headers.get('authorization'), 'Bearer sdb_agt_test')
  assert.equal(calls[1].headers.get('x-stitch-session'), 's1')
  assert.deepEqual(calls[1].body, { query: 'delete from t' })
})

test('errors: status, message, code, hint and body', async () => {
  const { mgmt } = client((c) => {
    if (c.url.includes('/database/query')) return [400, { error: 'relation "nope" does not exist', code: '42P01', hint: 'Check the table name', position: 15 }]
    if (c.url.includes('/limits')) return [500, 'upstream exploded']
    if (c.url.endsWith(`/projects/${REF}`)) return [404, { error: 'Project not found' }]
    return [401, { error: 'Invalid token' }]
  })
  const q = await mgmt.database.query(REF, 'select * from nope')
  assert.equal(q.data, null); assert.ok(q.error instanceof ManagementError)
  assert.equal(q.error.status, 400); assert.equal(q.error.code, '42P01'); assert.equal(q.error.hint, 'Check the table name'); assert.equal(q.error.position, 15)
  assert.match(q.error.message, /does not exist/); assert.equal(q.error.body.code, '42P01')
  const g = await mgmt.projects.get(REF)
  assert.equal(g.error.status, 404); assert.match(g.error.hint, /project reference/)
  const u = await mgmt.organizations.list()
  assert.equal(u.error.status, 401); assert.match(u.error.hint, /invalid or expired/)
  const t = await mgmt.projects.limits(REF)
  assert.equal(t.error.status, 500); assert.equal(t.error.message, 'upstream exploded')
  const net = await createManagementClient({ accessToken: TOKEN, apiUrl: API, fetch: async () => { throw new TypeError('fetch failed') } }).projects.delete(REF)
  assert.equal(net.error.status, 0); assert.match(net.error.message, /Could not reach/)
})

test('retries 429/502/503 with Retry-After, then gives up', async () => {
  const { mgmt, calls } = client((_c, n) => (n === 1 ? [429, { error: 'slow down' }, { 'retry-after': '0' }] : n === 2 ? [503, { error: 'busy' }, { 'retry-after': '0' }] : [200, { ok: true }]))
  const r = await mgmt.projects.pause(REF)
  assert.equal(r.error, null); assert.deepEqual(r.data, { ok: true }); assert.equal(calls.length, 3)
  assert.ok(calls.every((c) => c.method === 'POST'))

  const always = mockFetch(() => [502, { error: 'bad gateway' }, { 'retry-after': '0' }])
  const m2 = createManagementClient({ accessToken: TOKEN, apiUrl: API, fetch: always.fetch, retries: 2 })
  const r2 = await m2.projects.list()
  assert.equal(r2.error.status, 502); assert.equal(always.calls.length, 3)

  const none = mockFetch(() => [429, { error: 'slow down' }, { 'retry-after': '0' }])
  const r3 = await createManagementClient({ accessToken: TOKEN, apiUrl: API, fetch: none.fetch, retries: 0 }).projects.list()
  assert.equal(r3.error.status, 429); assert.equal(none.calls.length, 1)

  const other = mockFetch(() => [500, { error: 'nope' }])
  await createManagementClient({ accessToken: TOKEN, apiUrl: API, fetch: other.fetch }).projects.list()
  assert.equal(other.calls.length, 1, '500 is not retried')
})

test('request(): any path, query and body', async () => {
  const { mgmt, calls } = client(() => [200, { ok: 1 }])
  const r = await mgmt.request('POST', `/projects/${REF}/import/cutover`, { query: { a: 1, skip: undefined }, body: { x: true } })
  assert.deepEqual(r.data, { ok: 1 })
  assert.equal(calls[0].url, `${BASE}/projects/${REF}/import/cutover?a=1`); assert.deepEqual(calls[0].body, { x: true })
})
