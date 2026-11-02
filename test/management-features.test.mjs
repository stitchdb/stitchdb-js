// Dashboard features on the Management API. Run after `npm run build`: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagementClient, ManagementError } from '../dist/management.mjs'

const API = 'https://api.example.test'
const TOKEN = 'sdb_pat_test_0000000000000000'
const REF = 'abcdefghijklmnop'
const P = `/projects/${REF}`
const UUID = '99999999-8888-7777-6666-555555555555'

function client(route = () => [200, {}]) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: new Headers(init.headers), body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    const [status, body] = route(call) || [200, {}]
    const isText = typeof body === 'string'
    return new Response(isText ? body : JSON.stringify(body), { status, headers: { 'content-type': isText ? 'text/csv' : 'application/json' } })
  }
  return { mgmt: createManagementClient({ accessToken: TOKEN, apiUrl: API, fetch }), calls }
}
const path = (c) => { const u = new URL(c.url); return u.pathname.replace('/platform/v1', '') + u.search }
const lines = (calls) => calls.map((c) => `${c.method} ${path(c)}`)

test('backups, compute, restart, replicas, budget, exports', async () => {
  const { mgmt, calls } = client()
  await mgmt.backups.list(REF)
  await mgmt.backups.create(REF)
  await mgmt.backups.restore(REF, 12)
  await mgmt.backups.exportLink(REF)
  await mgmt.backups.downloadLink(REF, 12, { files: true })
  await mgmt.backups.pitr(REF)
  await mgmt.backups.restoreToTime(REF, { target_time: '2026-11-01T12:00:00Z', branch: 'before' })
  await mgmt.backups.jobs(REF)
  await mgmt.backups.job(REF, 7)
  await mgmt.backups.restoreTable(REF, { table: 'orders', mode: 'copy', where: 'id > 10', target_time: '2026-11-01T12:00:00Z' })
  await mgmt.compute.get(REF)
  await mgmt.compute.catalog(REF, { location: 'eu', kind: 'cloud' })
  await mgmt.compute.estimate(REF, { size_key: 'm2' })
  await mgmt.compute.change(REF, { size_key: 'm2', idempotency_key: 'k1' })
  await mgmt.projects.restart(REF)
  await mgmt.replicas.list(REF)
  await mgmt.replicas.add(REF)
  await mgmt.replicas.remove(REF, UUID)
  await mgmt.replicas.auto.get(REF)
  await mgmt.replicas.auto.set(REF, { enabled: true, up_pct: 80, max_replicas: 2 })
  await mgmt.budget.get(REF)
  await mgmt.budget.set(REF, { limits: { egress_gb: 100 }, thresholds: [50, 100] })
  await mgmt.budget.delete(REF)
  await mgmt.budget.test(REF)
  await mgmt.exports.list(REF)
  await mgmt.exports.start(REF)
  await mgmt.exports.startImport(REF)
  await mgmt.exports.restoreImport(REF, '0123456789abcdef')
  await mgmt.exports.delete(REF, '0123456789abcdef')
  assert.deepEqual(lines(calls), [
    `GET ${P}/backups`, `POST ${P}/backups`, `POST ${P}/backups/12/restore`, `POST ${P}/backups/export`, `GET ${P}/backups/12/download?files=1`,
    `GET ${P}/backups/pitr`, `POST ${P}/backups/pitr`, `GET ${P}/backups/jobs`, `GET ${P}/backups/jobs/7`, `POST ${P}/backups/table-restore`,
    `GET ${P}/compute`, `GET ${P}/compute/catalog?location=eu&kind=cloud`, `POST ${P}/compute/estimate`, `POST ${P}/compute`, `POST ${P}/restart`,
    `GET ${P}/replicas`, `POST ${P}/replicas`, `DELETE ${P}/replicas/${UUID}`, `GET ${P}/auto-replicas`, `PUT ${P}/auto-replicas`,
    `GET ${P}/budget`, `PUT ${P}/budget`, `DELETE ${P}/budget`, `POST ${P}/budget/test`,
    `GET ${P}/export`, `POST ${P}/export`, `POST ${P}/export/import`, `POST ${P}/export/import/0123456789abcdef/restore`, `DELETE ${P}/export/0123456789abcdef`,
  ])
  assert.deepEqual(calls[6].body, { target_time: '2026-11-01T12:00:00Z', branch: 'before' })
  assert.deepEqual(calls[9].body, { table: 'orders', mode: 'copy', where: 'id > 10', target_time: '2026-11-01T12:00:00Z' })
  assert.deepEqual(calls[13].body, { size_key: 'm2', idempotency_key: 'k1' })
  assert.deepEqual(calls[19].body, { enabled: true, up_pct: 80, max_replicas: 2 })
  assert.deepEqual(calls[21].body, { limits: { egress_gb: 100 }, thresholds: [50, 100] })
  assert.equal(calls[0].body, undefined)
})

test('flags and rate limits', async () => {
  const { mgmt, calls } = client()
  await mgmt.flags.get(REF)
  await mgmt.flags.enable(REF)
  await mgmt.flags.disable(REF)
  await mgmt.flags.create(REF, { key: 'new-checkout', enabled: true })
  await mgmt.flags.update(REF, 'new-checkout', { archived: true })
  await mgmt.flags.delete(REF, 'new-checkout')
  await mgmt.flags.stats(REF, 'new-checkout')
  await mgmt.flags.segments.create(REF, { key: 'beta', included: ['a@b.c'] })
  await mgmt.flags.segments.update(REF, 'beta', { name: 'Beta' })
  await mgmt.flags.segments.delete(REF, 'beta')
  await mgmt.flags.history(REF, { key: 'new-checkout', limit: 5 })
  await mgmt.flags.restore(REF, 3, { side: 'before' })
  await mgmt.flags.test(REF, { user: { id: 'u1' } })
  await mgmt.rateLimits.get(REF)
  await mgmt.rateLimits.update(REF, [{ path: '/rest/v1/*', limit: 100 }])
  await mgmt.rateLimits.installSql(REF)
  await mgmt.rateLimits.removeSql(REF)
  assert.deepEqual(lines(calls), [
    `GET ${P}/flags`, `POST ${P}/flags`, `DELETE ${P}/flags`, `POST ${P}/flags/flags`, `PATCH ${P}/flags/flags/new-checkout`, `DELETE ${P}/flags/flags/new-checkout`,
    `GET ${P}/flags/flags/new-checkout/stats`, `POST ${P}/flags/segments`, `PATCH ${P}/flags/segments/beta`, `DELETE ${P}/flags/segments/beta`,
    `GET ${P}/flags/history?key=new-checkout&limit=5`, `POST ${P}/flags/history/3/restore`, `POST ${P}/flags/test`,
    `GET ${P}/rate-limits`, `PATCH ${P}/rate-limits`, `POST ${P}/rate-limits/sql`, `DELETE ${P}/rate-limits/sql`,
  ])
  assert.deepEqual(calls[3].body, { key: 'new-checkout', enabled: true })
  assert.deepEqual(calls[11].body, { side: 'before' })
  assert.deepEqual(calls[14].body, { rules: [{ path: '/rest/v1/*', limit: 100 }] })
})

test('inbound webhooks and the status page', async () => {
  const { mgmt, calls } = client()
  await mgmt.inbound.get(REF)
  await mgmt.inbound.enable(REF)
  await mgmt.inbound.endpoints.create(REF, { slug: 'stripe', provider: 'stripe', secret: 'whsec_x' })
  await mgmt.inbound.endpoints.update(REF, 'stripe', { enabled: false })
  await mgmt.inbound.endpoints.delete(REF, 'stripe', { events: true })
  await mgmt.inbound.endpoints.test(REF, 'stripe', { type: 'ping' })
  await mgmt.inbound.events.list(REF, { endpoint: 'stripe', status: 'failed', limit: 10 })
  await mgmt.inbound.events.get(REF, 5)
  await mgmt.inbound.events.redeliver(REF, 5)
  await mgmt.inbound.events.delete(REF, 5)
  await mgmt.inbound.disable(REF)
  await mgmt.statusPage.get(REF)
  await mgmt.statusPage.enable(REF)
  await mgmt.statusPage.update(REF, { title: 'Shop status' })
  await mgmt.statusPage.incidents.create(REF, { title: 'Slow sign-in', message: 'Looking into it', impact: 'minor' })
  await mgmt.statusPage.incidents.update(REF, 'abcdef0123', { status: 'resolved', message: 'Fixed' })
  await mgmt.statusPage.incidents.editUpdate(REF, 'abcdef0123', 2, { message: 'Fixed for all users' })
  await mgmt.statusPage.incidents.delete(REF, 'abcdef0123')
  await mgmt.statusPage.subscribers.list(REF)
  await mgmt.statusPage.subscribers.remove(REF, 9)
  await mgmt.statusPage.disable(REF)
  assert.deepEqual(lines(calls), [
    `GET ${P}/inbound`, `POST ${P}/inbound`, `POST ${P}/inbound/endpoints`, `PATCH ${P}/inbound/endpoints/stripe`, `DELETE ${P}/inbound/endpoints/stripe?events=1`,
    `POST ${P}/inbound/endpoints/stripe/test`, `GET ${P}/inbound/events?endpoint=stripe&status=failed&limit=10`, `GET ${P}/inbound/events/5`,
    `POST ${P}/inbound/events/5/redeliver`, `DELETE ${P}/inbound/events/5`, `DELETE ${P}/inbound`,
    `GET ${P}/status-page`, `POST ${P}/status-page`, `PUT ${P}/status-page/settings`, `POST ${P}/status-page/incidents`, `PATCH ${P}/status-page/incidents/abcdef0123`,
    `PATCH ${P}/status-page/incidents/abcdef0123/updates/2`, `DELETE ${P}/status-page/incidents/abcdef0123`, `GET ${P}/status-page/subscribers`,
    `DELETE ${P}/status-page/subscribers/9`, `DELETE ${P}/status-page`,
  ])
  assert.deepEqual(calls[2].body, { slug: 'stripe', provider: 'stripe', secret: 'whsec_x' })
  assert.deepEqual(calls[5].body, { type: 'ping' })
  assert.deepEqual(calls[14].body, { title: 'Slow sign-in', message: 'Looking into it', impact: 'minor' })
  assert.deepEqual(calls[16].body, { message: 'Fixed for all users' })
})

test('cron and queues', async () => {
  const { mgmt, calls } = client()
  await mgmt.cron.list(REF)
  await mgmt.cron.runs(REF, { jobid: 3 })
  await mgmt.cron.create(REF, { name: 'nightly', schedule: '0 3 * * *', command: 'select 1' })
  await mgmt.cron.update(REF, 3, { active: false })
  await mgmt.cron.delete(REF, 3)
  await mgmt.queues.list(REF)
  await mgmt.queues.create(REF, { name: 'emails', type: 'unlogged' })
  await mgmt.queues.messages(REF, 'emails', { archived: true })
  await mgmt.queues.send(REF, 'emails', { message: { to: 'a@b.c' }, delay: 10 })
  await mgmt.queues.read(REF, 'emails', { vt: 60, qty: 5 })
  await mgmt.queues.archive(REF, 'emails', 11)
  await mgmt.queues.deleteMessage(REF, 'emails', 12)
  await mgmt.queues.delete(REF, 'emails')
  assert.deepEqual(lines(calls), [
    `GET ${P}/cron/jobs`, `GET ${P}/cron/runs?jobid=3`, `POST ${P}/cron/jobs`, `PATCH ${P}/cron/jobs/3`, `DELETE ${P}/cron/jobs/3`,
    `GET ${P}/queues`, `POST ${P}/queues`, `GET ${P}/queues/emails/messages?archived=true`, `POST ${P}/queues/emails/messages`, `POST ${P}/queues/emails/read`,
    `POST ${P}/queues/emails/messages/11/archive`, `POST ${P}/queues/emails/messages/12/delete`, `DELETE ${P}/queues/emails`,
  ])
  assert.deepEqual(calls[2].body, { jobname: 'nightly', schedule: '0 3 * * *', command: 'select 1' })
  assert.deepEqual(calls[3].body, { active: false })
  assert.deepEqual(calls[6].body, { name: 'emails', type: 'unlogged', unlogged: true })
  assert.deepEqual(calls[8].body, { message: { to: 'a@b.c' }, delay: 10 })
  assert.deepEqual(calls[9].body, { vt: 60, qty: 5 })
})

test('push, purchases, links', async () => {
  const { mgmt, calls } = client()
  await mgmt.push.get(REF)
  await mgmt.push.configure(REF, { ios: null, android: { service_account: '{"type":"service_account"}' } })
  await mgmt.push.test(REF, { user_id: UUID, title: 'Hi' })
  await mgmt.push.disable(REF)
  await mgmt.purchases.get(REF)
  await mgmt.purchases.configure(REF, { products: [] })
  await mgmt.purchases.testWebhook(REF, 'abcdef0123')
  await mgmt.purchases.retryDelivery(REF, 4)
  await mgmt.purchases.disable(REF)
  await mgmt.links.get(REF)
  await mgmt.links.enable(REF)
  await mgmt.links.updateSettings(REF, { web_url: 'https://shop.example' })
  await mgmt.links.items.list(REF, { q: 'promo', limit: 20, offset: 40 })
  await mgmt.links.items.create(REF, { code: 'promo', data: { screen: 'sale' } })
  await mgmt.links.items.get(REF, 'promo', { days: 7 })
  await mgmt.links.items.update(REF, 'promo', { data: { screen: 'home' } })
  await mgmt.links.items.delete(REF, 'promo')
  await mgmt.links.disable(REF)
  assert.deepEqual(lines(calls), [
    `GET ${P}/push`, `PATCH ${P}/push`, `POST ${P}/push/test`, `DELETE ${P}/push`,
    `GET ${P}/purchases`, `PATCH ${P}/purchases`, `POST ${P}/purchases/webhooks/abcdef0123/test`, `POST ${P}/purchases/deliveries/4/retry`, `DELETE ${P}/purchases`,
    `GET ${P}/links`, `POST ${P}/links`, `PUT ${P}/links/settings`, `GET ${P}/links/items?q=promo&limit=20&offset=40`, `POST ${P}/links/items`,
    `GET ${P}/links/items/promo?days=7`, `PATCH ${P}/links/items/promo`, `DELETE ${P}/links/items/promo`, `DELETE ${P}/links`,
  ])
  assert.deepEqual(calls[1].body, { ios: null, android: { service_account: '{"type":"service_account"}' } })
  assert.deepEqual(calls[2].body, { user_id: UUID, title: 'Hi' })
  assert.deepEqual(calls[13].body, { code: 'promo', data: { screen: 'sale' } })
})

test('metering, heartbeat, crashes', async () => {
  const { mgmt, calls } = client((c) => (c.url.includes('/metering/export') ? [200, 'customer,meter,value\nc1,api,3\n'] : [200, {}]))
  await mgmt.metering.get(REF)
  await mgmt.metering.enable(REF)
  await mgmt.metering.updateSettings(REF, { meters: [] })
  await mgmt.metering.setStripe(REF, { secret_key: 'sk_test_x' })
  await mgmt.metering.stripeCustomers(REF, { q: 'acme' })
  await mgmt.metering.setStripeCustomers(REF, { customers: [{ customer: 'acme', stripe_customer: 'cus_1' }] })
  await mgmt.metering.retryStripe(REF)
  await mgmt.metering.customers(REF, { from: '2026-10-01', meter: 'api' })
  await mgmt.metering.customer(REF, 'team/a b', { from: '2026-10-01' })
  const csv = await mgmt.metering.export(REF, { from: '2026-10-01', to: '2026-10-31' })
  await mgmt.metering.disable(REF)
  assert.equal(csv.data, 'customer,meter,value\nc1,api,3\n')
  assert.match(calls[9].headers.get('accept'), /text\/csv/)
  await mgmt.heartbeat.get(REF)
  await mgmt.heartbeat.enable(REF)
  await mgmt.heartbeat.updateSettings(REF, { email: true })
  await mgmt.heartbeat.test(REF)
  await mgmt.heartbeat.monitors.create(REF, { kind: 'ping', name: 'backup', period_s: 3600, grace_s: 300 })
  await mgmt.heartbeat.monitors.get(REF, 8, { limit: 20 })
  await mgmt.heartbeat.monitors.update(REF, 8, { paused: true })
  await mgmt.heartbeat.monitors.rotateToken(REF, 8)
  await mgmt.heartbeat.monitors.delete(REF, 8)
  await mgmt.heartbeat.disable(REF)
  await mgmt.crashes.get(REF)
  await mgmt.crashes.enable(REF)
  await mgmt.crashes.updateSettings(REF, { new_issue: true })
  await mgmt.crashes.test(REF)
  await mgmt.crashes.issues.list(REF, { status: 'open', limit: 10 })
  await mgmt.crashes.issues.get(REF, 42)
  await mgmt.crashes.issues.update(REF, 42, { status: 'resolved' })
  await mgmt.crashes.disable(REF)
  assert.deepEqual(lines(calls), [
    `GET ${P}/metering`, `POST ${P}/metering`, `PUT ${P}/metering/settings`, `PUT ${P}/metering/stripe`, `GET ${P}/metering/stripe/customers?q=acme`,
    `PUT ${P}/metering/stripe/customers`, `POST ${P}/metering/stripe/retry`, `GET ${P}/metering/customers?from=2026-10-01&meter=api`,
    `GET ${P}/metering/customers/team%2Fa%20b?from=2026-10-01`, `GET ${P}/metering/export?from=2026-10-01&to=2026-10-31`, `DELETE ${P}/metering`,
    `GET ${P}/heartbeat`, `POST ${P}/heartbeat`, `PUT ${P}/heartbeat/settings`, `POST ${P}/heartbeat/test`, `POST ${P}/heartbeat/monitors`,
    `GET ${P}/heartbeat/monitors/8?limit=20`, `PATCH ${P}/heartbeat/monitors/8`, `POST ${P}/heartbeat/monitors/8/token`, `DELETE ${P}/heartbeat/monitors/8`, `DELETE ${P}/heartbeat`,
    `GET ${P}/crashes`, `POST ${P}/crashes`, `PUT ${P}/crashes/settings`, `POST ${P}/crashes/test`, `GET ${P}/crashes/issues?status=open&limit=10`,
    `GET ${P}/crashes/issues/42`, `PATCH ${P}/crashes/issues/42`, `DELETE ${P}/crashes`,
  ])
  assert.deepEqual(calls[3].body, { secret_key: 'sk_test_x' })
  assert.deepEqual(calls[15].body, { kind: 'ping', name: 'backup', period_s: 3600, grace_s: 300 })
  assert.deepEqual(calls[27].body, { status: 'resolved' })
})

test('SSO providers, recycle bin, change history, shared views', async () => {
  const { mgmt, calls } = client()
  await mgmt.authConfig.sso.list(REF)
  await mgmt.authConfig.sso.create(REF, { metadata_url: 'https://idp.example/metadata', domains: ['acme.example'] })
  await mgmt.authConfig.sso.update(REF, UUID, { domains: ['acme.example', 'acme.test'] })
  await mgmt.authConfig.sso.delete(REF, UUID)
  await mgmt.recycleBin.get(REF, { table: 'orders', limit: 10 })
  await mgmt.recycleBin.setTable(REF, { table: 'orders', enabled: true })
  await mgmt.recycleBin.restore(REF, [1, 2])
  await mgmt.recycleBin.purge(REF, [3])
  await mgmt.history.get(REF, { table: 'orders', pk: '7' })
  await mgmt.history.setTable(REF, { schema: 'public', table: 'orders', enabled: false })
  await mgmt.history.revert(REF, 99)
  await mgmt.sharedViews.list(REF)
  await mgmt.sharedViews.create(REF, { name: 'Orders', table: 'orders', columns: ['id', 'total'] })
  await mgmt.sharedViews.get(REF, 'sv_0123456789abcdef')
  await mgmt.sharedViews.update(REF, 'sv_0123456789abcdef', { disabled: true })
  await mgmt.sharedViews.addMembers(REF, 'sv_0123456789abcdef', ['a@b.c'], { send: false })
  await mgmt.sharedViews.removeMember(REF, 'sv_0123456789abcdef', 'a+x@b.c')
  await mgmt.sharedViews.audit(REF, 'sv_0123456789abcdef', { limit: 50 })
  await mgmt.sharedViews.delete(REF, 'sv_0123456789abcdef')
  assert.deepEqual(lines(calls), [
    `GET ${P}/config/auth/sso/providers`, `POST ${P}/config/auth/sso/providers`, `PUT ${P}/config/auth/sso/providers/${UUID}`, `DELETE ${P}/config/auth/sso/providers/${UUID}`,
    `GET ${P}/recycle-bin?table=orders&limit=10`, `PUT ${P}/recycle-bin/tables`, `POST ${P}/recycle-bin/restore`, `POST ${P}/recycle-bin/purge`,
    `GET ${P}/history?table=orders&pk=7`, `PUT ${P}/history/tables`, `POST ${P}/history/revert`,
    `GET ${P}/shared-views`, `POST ${P}/shared-views`, `GET ${P}/shared-views/sv_0123456789abcdef`, `PATCH ${P}/shared-views/sv_0123456789abcdef`,
    `POST ${P}/shared-views/sv_0123456789abcdef/members`, `DELETE ${P}/shared-views/sv_0123456789abcdef/members?email=a%2Bx%40b.c`,
    `GET ${P}/shared-views/sv_0123456789abcdef/audit?limit=50`, `DELETE ${P}/shared-views/sv_0123456789abcdef`,
  ])
  assert.deepEqual(calls[1].body, { metadata_url: 'https://idp.example/metadata', domains: ['acme.example'] })
  assert.deepEqual(calls[6].body, { ids: [1, 2] }); assert.deepEqual(calls[7].body, { ids: [3] })
  assert.deepEqual(calls[9].body, { schema: 'public', table: 'orders', enabled: false })
  assert.deepEqual(calls[10].body, { id: 99 })
  assert.deepEqual(calls[15].body, { emails: ['a@b.c'], send: false })
  assert.equal(calls[16].body, undefined)
})

test('cloudflare integration', async () => {
  const { mgmt, calls } = client()
  await mgmt.integrations.cloudflare.list(REF)
  await mgmt.integrations.cloudflare.browse(REF, { token: 'cf_token', account_id: 'acc1' })
  await mgmt.integrations.cloudflare.link(REF, { token: 'cf_token', account_id: 'acc1', kind: 'worker', name: 'api', targets: ['production'], prefix: '', service_key: false, hyperdrive: true })
  await mgmt.integrations.cloudflare.update(REF, UUID, { targets: ['production', 'preview'] })
  await mgmt.integrations.cloudflare.sync(REF, UUID)
  await mgmt.integrations.cloudflare.unlink(REF, UUID, { removeVariables: true })
  await mgmt.integrations.cloudflare.unlink(REF, UUID)
  assert.deepEqual(lines(calls), [
    `GET ${P}/integrations/cloudflare`, `POST ${P}/integrations/cloudflare/browse`, `POST ${P}/integrations/cloudflare`, `PATCH ${P}/integrations/cloudflare/${UUID}`,
    `POST ${P}/integrations/cloudflare/${UUID}/sync`, `DELETE ${P}/integrations/cloudflare/${UUID}?remove_variables=true`, `DELETE ${P}/integrations/cloudflare/${UUID}`,
  ])
  assert.deepEqual(calls[1].body, { token: 'cf_token', account_id: 'acc1' })
  assert.deepEqual(calls[2].body, { token: 'cf_token', account_id: 'acc1', kind: 'worker', name: 'api', targets: ['production'], prefix: '', service_key: false, hyperdrive: true })
  assert.deepEqual(calls[3].body, { targets: ['production', 'preview'] })
})

test('a 403 (missing scope) comes back as { error } with the status', async () => {
  const { mgmt } = client(() => [403, { error: 'This token is missing the scope database:write', code: 'insufficient_scope' }])
  for (const r of [await mgmt.cron.create(REF, { name: 'x', schedule: '0 3 * * *', command: 'select 1' }), await mgmt.backups.list(REF), await mgmt.integrations.cloudflare.list(REF)]) {
    assert.equal(r.data, null); assert.equal(r.status, 403)
    assert.ok(r.error instanceof ManagementError); assert.equal(r.error.status, 403)
    assert.equal(r.error.code, 'insufficient_scope'); assert.match(r.error.message, /database:write/)
  }
})
