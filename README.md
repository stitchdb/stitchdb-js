# stitchdb-js

The official JavaScript and TypeScript client for [StitchDB](https://stitchdb.com): Postgres database, Auth, Storage, Realtime and Edge Functions from one client.

```bash
npm install stitchdb-js
```

Works in browsers, Node.js 18+, Deno, Bun, Edge Functions and React Native.

## Quick start

```js
import { createClient } from 'stitchdb-js'

const stitchdb = createClient(process.env.STITCHDB_URL, process.env.STITCHDB_ANON_KEY)
```

Find the project URL (`https://<project-ref>.p.stitchdb.com`) and the anon key in the dashboard under **Settings → API keys**. The anon key is safe in browsers: Row Level Security decides what each user can read and write. Use the service_role key only on servers you control.

### Database

```js
const { data, error } = await stitchdb
  .from('todos')
  .select('id, task, profiles(username)')
  .eq('is_complete', false)
  .order('id')
  .limit(20)

await stitchdb.from('todos').insert({ task: 'Ship it' }).select()
await stitchdb.from('todos').update({ is_complete: true }).eq('id', 1)
await stitchdb.from('todos').delete().eq('id', 1)
await stitchdb.rpc('search_todos', { term: 'ship' })
```

### GraphQL

Turn on the GraphQL API in Studio › API › GraphQL. It uses the same API keys and row level security as the REST API; signed in, queries run as the user.

```js
const { data, error } = await stitchdb.graphql(`
  query Todos($done: Boolean) {
    todosCollection(filter: { is_complete: { eq: $done } }, first: 20) { edges { node { id task } } }
  }`, { variables: { done: false } })
```

`error` is set when the request failed or the answer has GraphQL errors; `errors` has them as the server sent them.

### Auth

```js
await stitchdb.auth.signUp({ email, password })
await stitchdb.auth.signInWithPassword({ email, password })
await stitchdb.auth.signInWithOtp({ email })
await stitchdb.auth.signInWithOAuth({ provider: 'github' })
await stitchdb.auth.signInAnonymously()
await stitchdb.auth.mfa.enroll({ factorType: 'totp' })

const { data: { user } } = await stitchdb.auth.getUser()
stitchdb.auth.onAuthStateChange((event, session) => {})
await stitchdb.auth.signOut()
```

No auth screens of your own: turn on **Authentication › Hosted sign-in** in Studio and send users to the hosted page (sign-in, sign-up, sign-in links, password reset, two-step). With `flowType: 'pkce'` they come back with a one-time code the client exchanges for a session.

```js
await stitchdb.auth.signInWithHostedPage({ redirectTo: 'https://yourapp.com/auth/callback', view: 'sign-up' })
```

In the browser, `signUp` and `signInWithOtp` store the browser language as `locale` in the user's metadata (unless you pass `locale`, `language` or `lang` yourself), so a project with several e-mail languages sends each user their confirmation and sign-in e-mails in their language.

When the project's fake sign-up protection asks for its built-in check (`captcha_required`), `signUp` and `signInWithOtp` solve it (a short proof of work) and send the request again; you do not need to handle it.

Also available: phone and SMS OTP, SAML SSO, Web3 (Ethereum and Solana) sign-in, passkeys, identity linking and the admin API (with the service_role key).

### Storage

```js
await stitchdb.storage.from('avatars').upload('user-1/avatar.png', file)
const { data } = stitchdb.storage.from('avatars').getPublicUrl('user-1/avatar.png')
await stitchdb.storage.from('invoices').createSignedUrl('2026/inv-1.pdf', 60)
```

### Realtime

```js
stitchdb
  .channel('room-1')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, (payload) => console.log(payload))
  .on('broadcast', { event: 'cursor' }, (payload) => console.log(payload))
  .subscribe()
```

No lost messages: with message history on (Studio → Realtime inspector → Message history), a channel created with
`history: true` gets the broadcasts it missed while offline, in order, when it reconnects.

```js
const chat = stitchdb.channel('chat:42', { config: { private: true, history: true } })
chat.on('broadcast', { event: 'message' }, ({ payload, meta }) => render(payload, meta?.replayed)).subscribe()
await chat.publish('message', { text: 'hi' }) // stored, then delivered; resolves when stored
```

### Edge Functions

```js
const { data, error } = await stitchdb.functions.invoke('hello-world', { body: { name: 'Ada' } })
```

### Search

Search a table that has a search index (Studio › Database › Search) by words and, optionally, by meaning. Your row level security policies decide which rows come back.

```ts
const { data, scores, error } = await stitchdb.search('posts', 'running shoes', { limit: 20 })
// mode: 'hybrid' (default for semantic indexes), 'keyword' or 'semantic'; select: 'id,title'
```

### Push notifications

```js
// In the app, after sign-in: register this device (APNs token, FCM token, or a browser subscription)
await stitchdb.push.register({ platform: 'ios', token: apnsToken })
await stitchdb.push.registerBrowser(await navigator.serviceWorker.ready) // web
await stitchdb.push.subscribe('news')

// In-app inbox
const { notifications, unread } = await stitchdb.push.inbox()
await stitchdb.push.markRead('all')
const stop = await stitchdb.push.onNotification((n) => console.log(n.title))

// Server side (service role key): send
await admin.push.send({ user_id, title: 'Order shipped', body: 'Arrives Tuesday', data: { order: 42 } })
```

### In-app purchases

```js
// After a StoreKit 2 purchase (or a Google Play purchase), and on restore
const { entitlements } = await stitchdb.purchases.sync({ store: 'apple', signed_transaction: transaction.jwsRepresentation })
await stitchdb.purchases.sync({ store: 'google', purchase_token: purchase.purchaseToken, product_id: 'pro_monthly' })

if (await stitchdb.purchases.hasEntitlement('pro')) showProFeatures()
```

### Organizations

Teams and workspaces for your app's users. Turn it on in Studio → Authentication → Organizations.

```js
const org = await stitchdb.orgs.create({ name: 'Acme' })            // you become owner
await stitchdb.orgs.invite(org.id, { email: 'bob@example.com', role: 'admin' })
await stitchdb.orgs.acceptInvite(token)                            // on the page the invite e-mail links to
await stitchdb.orgs.setActive(org.id)                              // JWT now carries org_id and org_role
```

In your policies: `auth.is_member(org_id)`, `auth.has_role('admin', org_id)`, `auth.org_id()`.

### Offline sync

Keep a copy of tables on the device: reads are instant, writes work offline and sync later. Turn it on per table in Studio → Database → Offline sync.

```js
const db = stitchdb.offline({ tables: ['todos'] })   // IndexedDB in the browser
await db.ready

const todos = db.table('todos')
await todos.upsert({ id: crypto.randomUUID(), title: 'Buy milk' })  // queued until online
todos.all()                                                          // local rows
todos.subscribe((rows) => render(rows))
db.on('conflict', (c) => console.log(c.table, c.status, c.server))
db.on('status', (s) => console.log(s.online, s.pending))
await db.close({ clear: true })                                      // on sign-out
```

### Background jobs

Durable multi-step jobs as Edge Functions: each step runs once and is saved, failing steps are retried, runs can sleep for days. Turn it on in Studio → Edge Functions → Background jobs.

```ts
// functions/onboarding/index.ts
import { job } from 'stitchdb-js/jobs'   // or https://stitchdb.com/sdk/stitchdb-jobs.mjs

Deno.serve(job(async (payload, ctx) => {
  const user = await ctx.step('load user', () => loadUser(payload.user_id))
  await ctx.step('welcome e-mail', () => sendWelcome(user.email))
  await ctx.sleep('wait a day', '1d')
  await ctx.step('tips e-mail', () => sendTips(user.email))
}))
```

```js
// on your server, with the service key
await admin.jobs.start('onboarding', { user_id }, { idempotencyKey: `onboarding:${user_id}` })
```

Job mode: one long run (up to 15 min on Pro, 60 min on Scale) for light, mostly-waiting work such as imports, batch e-mails or AI calls over many documents, with progress, a log and checkpoints. Heavy CPU work (video, image processing) is not supported.

```ts
import { longJob } from 'stitchdb-js/jobs'

Deno.serve(longJob(async (payload, ctx) => {
  const rows = await loadCsv(payload.url)
  for (let i = ctx.checkpoint?.next ?? 0; i < rows.length; i++) {
    await importRow(rows[i])
    ctx.progress((i + 1) / rows.length, `${i + 1} of ${rows.length}`)
    if (i % 500 === 0) ctx.save({ next: i + 1 })
  }
  return { imported: rows.length }
}))

// await admin.jobs.start('import-csv', { url }, { mode: 'long' }); await admin.jobs.logs(id)
```

### Job monitoring

Get an alert when a scheduled job did not run, failed or ran too long (set monitors up in Studio). pg_cron jobs and background jobs are watched without code. A job that runs anywhere else calls its monitor's ping URL; the `hb_…` token in it is the secret, no API key is needed.

```js
// wraps the job in a start and an end ping; a throw is reported as a failure with the error
await stitchdb.heartbeat.run(process.env.NIGHTLY_MONITOR, () => exportOrders())

await stitchdb.heartbeat.ping(token, { status: 'start' })
await stitchdb.heartbeat.ping(token, { exitCode: 1, message: 'disk full' }) // 0 is success
stitchdb.heartbeat.pingUrl(token)                                          // for curl in a crontab

// server side, with the service key
const { data: monitors } = await admin.heartbeat.monitors()
const { data } = await admin.heartbeat.monitor(monitors[0].id, { limit: 50 }) // with its latest runs
```

### Feature flags

Turn features on for some users (a plan, a segment, a percentage) and read config values your app uses at runtime, changed in Studio › Integrations › Feature flags without a release.

```js
await stitchdb.flags.load({ attributes: { app_version: '2.4.1', country: 'DE' } })

if (stitchdb.flags.get('new-checkout', false)) showNewCheckout()
const limit = stitchdb.flags.get('upload-limit-mb', 10)   // the default until a value is known
stitchdb.flags.on('change', () => render())               // refreshes on sign-in, sign-out and every minute

// server side, with the service key (includes server-only flags)
const { data } = await admin.flags.evaluate({ id: user.id, email: user.email, app_metadata: user.app_metadata })
```

Flags are evaluated for the signed-in user from the session; the last values are kept in localStorage, so `get` answers at once on the next start and keeps working offline.

### Usage metering

Count what each of your customers uses (AI tokens, documents, minutes, seats) for billing or plan limits. Set meters up in Studio › Integrations › Usage metering; API requests and file storage per user can be counted automatically.

```js
// server side, with the service key: any customer, the same idempotency key is counted once
await admin.metering.record('ai_tokens', 1532, { customer: org.id, idempotencyKey: completion.id })
const { data } = await admin.metering.usage({ customer: org.id, group: 'month' })
const { data: csv } = await admin.metering.exportCsv({ from: '2026-10-01', to: '2026-11-01', group: 'month' })

// in the app, signed in: meters marked "apps may record", for the user's own customer
await stitchdb.metering.record('exports')

// service key: rows as JSON, Stripe customer ids for usage sent to Stripe, alerts that fired
const { data: rows } = await admin.metering.exportRows({ from: '2026-10-01', group: 'day' })
await admin.metering.setStripeCustomer(org.id, 'cus_P5x...')     // null removes it
const { data: alerts } = await admin.metering.alerts({ month: '2026-10' })
```

### Crash reporting

Uncaught errors and the errors you report, grouped into issues in Studio › Crashes, with the stack, breadcrumbs and the API call that failed right before the crash. Nothing is captured or sent before `start()`.

```js
stitchdb.crashes.start({ release: '1.4.0', environment: 'production' })

try { await checkout(cart) } catch (e) { stitchdb.crashes.captureException(e, { context: { cart: cart.id } }) }
stitchdb.crashes.addBreadcrumb({ type: 'ui', message: 'tap Checkout' })
await stitchdb.crashes.flush() // before a serverless function returns
```

On your server or in CI, with the service key: read and resolve issues, crash-free users per release, and upload JavaScript source maps so stacks show the original file, line and function.

```js
const { data } = await admin.crashes.issues({ status: 'open', release: '1.4.0' })
const { data: detail } = await admin.crashes.issue(data.issues[0].id)   // releases, days, latest events
await admin.crashes.updateIssue(data.issues[0].id, { status: 'resolved' })
const { data: releases } = await admin.crashes.releases({ days: 30 })

await admin.crashes.sourcemaps.upload({ release: '1.4.0', name: '/assets/app.js', map: await readFile('dist/assets/app.js.map') })
await admin.crashes.sourcemaps.list({ release: '1.4.0' })
await admin.crashes.sourcemaps.remove({ release: '1.3.0' })
```

The release must be exactly what the app passes to `start({ release })`. The CLI does the same for a whole build folder: `stitchdb sourcemaps upload dist --release 1.4.0`.

### Analytics

Track what users do, linked to the signed-in user (an anonymous id before sign-in, merged at sign-in): active users, funnels, retention and breakdowns in Studio › Analytics. Nothing is sent before `start()`; events are batched in the background and kept while offline.

```js
stitchdb.analytics.start({ release: '1.4.0' }) // page views on the web are tracked for you
stitchdb.analytics.track('purchase', { plan: 'pro', amount: 29 })
await stitchdb.analytics.optOut() // the user does not want to be tracked
```

Reports, on your server with the service key (ranges up to 90 days):

```js
const { data: overview } = await admin.analytics.overview({ days: 30 })          // DAU / WAU / MAU, top events
const { data: trend } = await admin.analytics.trend({ event: 'purchase', interval: 'week', measure: 'users', breakdown: 'plan' })
const { data: funnel } = await admin.analytics.funnel(['signup', 'onboarded', 'purchase'], { windowHours: 72 })
const { data: cohorts } = await admin.analytics.retention({ weeks: 8 })
const { data: events } = await admin.analytics.user({ userId: user.id })          // or { anonId }
```

### Deep links

Short links (`https://<project>/l/<code>` or your own domain) open your app on the right screen when it is installed (iOS Universal Links, Android App Links) and otherwise go to the App Store, Google Play or a web page. Set up your apps in Studio › Links.

```js
const { data: link } = await stitchdb.links.resolve(url)          // the URL the app was opened with
if (link) navigate(link.path, link.data)
const { data: first } = await stitchdb.links.deferred({ platform: 'ios' }) // first launch after an install, best effort
const { data: made } = await stitchdb.links.create({ path: '/invite/7', data: { from: 'ana' } })
```

### Status page

Your app's public status page (turn it on in Studio): whether the API, Auth, Storage, Edge Functions, Realtime, the database and your own URLs are up, 90 days of uptime, incidents and maintenance. No key is needed.

```js
const { data } = await stitchdb.status.get()
if (data && data.overall !== 'operational') showBanner(data.overall_label)

await stitchdb.status.subscribe('ana@example.com')   // e-mail updates; she gets a link to confirm first
stitchdb.status.badgeUrl({ component: 'api' })      // an SVG badge for a README or a site
stitchdb.status.pageUrl()                           // the page to link to
```

## Serverless SQL (edge runtimes)

`stitchdb-js/sql` sends Postgres queries over HTTPS and WebSocket, so it works in Cloudflare Workers, Vercel Edge, Deno Deploy and other runtimes that can't open TCP connections. Turn it on and create a SQL key in Studio › Database › Serverless SQL. The connection URL looks like `https://sdb_sql_...@<ref>.stitchdb.com`.

```ts
import { createSql } from 'stitchdb-js/sql'

const sql = createSql(env.STITCHDB_SQL_URL)
const todos = await sql`select * from todos where owner = ${userId} limit 20`

// Several statements in one transaction, in one request:
const [, [order]] = await sql.transaction([
  sql`update stock set left = left - 1 where sku = ${sku}`,
  sql`insert into orders (sku, buyer) values (${sku}, ${userId}) returning *`,
])

// Interactive transactions over a WebSocket session:
const db = await sql.connect()
await db.transaction(async (tx) => {
  const [acct] = await tx`select balance from accounts where id = ${id} for update`
  await tx`update accounts set balance = ${Number(acct.balance) - amount} where id = ${id}`
})
db.close()
```

Queries run as the project's owner, the same as the connection string. Keep the key on the server and never put it in a browser or an app. Values that would lose precision in JavaScript come back as strings: `int8`, `numeric`, dates and times. Without a bundler, import `https://stitchdb.com/sdk/stitchdb-sql.mjs`.

## Collaborative documents

Documents many people edit at once (text, whiteboards, forms) with live cursors, offline edits and history. Bring
[Yjs](https://docs.yjs.dev) and any editor binding for it; turn it on in Studio › Database › Collaborative docs.

```js
import * as Y from 'yjs'
const collab = stitchdb.collab({ Y })
const ydoc = new Y.Doc()
const room = await collab.open('plan-2026', ydoc, { create: { title: 'Plan 2026' } })
room.setPresence({ name: 'Ann', cursor: 4 })
room.on('presence', (peers) => drawCursors(peers))
await collab.share('plan-2026', bobId, 'editor')
const old = await room.loadSnapshot((await room.snapshots())[0].id)

// without a live connection (a server, a script): read a document, or write a change to it
const { doc } = await collab.load('plan-2026')
await collab.write('plan-2026', Y.encodeStateAsUpdate(changed))
```

Who may open and edit a document is row level security on `collab.documents`. Guide:
https://stitchdb.com/docs/realtime/collaborative-documents

## Server middleware

`stitchdb-js/middleware` builds fetch handlers (Edge Functions, Deno, Bun, Cloudflare Workers, Vercel, Node) from
small typed steps: each one adds a key to `ctx`, can answer early, and can change the response on the way out.

```ts
import { pipeline, withClaims, withRequiredClaims, withStitchClient } from 'stitchdb-js/middleware'

export default {
  fetch: pipeline([withClaims(), withRequiredClaims(), withStitchClient()], async (req, ctx) => {
    // ctx.claims: the signed-in user; ctx.stitch: a client acting as them (Row Level Security applies).
    const { data, error } = await ctx.stitch.from('todos').select('*')
    if (error) throw error
    return Response.json({ user: ctx.claims.sub, todos: data })
  }),
}
```

Built-in steps: `withClaims`, `withRequiredClaims`, `withStitchClient`, `withStitchAdminClient`, `withPostgresClient`,
`withPostgresAdminClient`, `withRateLimit`, `withRequestId`, `withCors`, `withOAuthProtectedResource`; your own with
`defineMiddleware`. Duplicate steps and steps placed before the ones they need are TypeScript errors. Throw
`HttpError` for JSON errors; `toNodeHandler` serves a pipeline with `node:http`. Docs:
[stitchdb.com/docs/functions/middleware](https://stitchdb.com/docs/functions/middleware).

## Management API

`stitchdb-js/management` creates and runs projects from code: provisioning, SQL, migrations, branches, Edge Functions, secrets, webhooks, logs, custom domains, organizations and tokens. It calls the Management API at `https://stitchdb.com/platform/v1`, the same API the `stitchdb` CLI uses.

```ts
import { createManagementClient } from 'stitchdb-js/management'

const mgmt = createManagementClient({ accessToken: process.env.STITCHDB_ACCESS_TOKEN! })

const { data: project, error } = await mgmt.projects.create({ name: 'shop', labels: { env: 'preview' } }, { idempotencyKey: 'pr-42' })
if (error) throw error // ManagementError: status, message, code, hint

await mgmt.migrations.apply(project.ref, [{ version: '20261101000000', name: 'init', sql: 'create table orders (id bigint primary key)' }])
const { data: res } = await mgmt.database.query(project.ref, 'select count(*) from orders')

await mgmt.functions.deploy(project.ref, { slug: 'hello', files: [{ name: 'index.ts', content: 'Deno.serve(() => new Response("hi"))' }] })
await mgmt.secrets.set(project.ref, { STRIPE_KEY: 'sk_live_...' })

// Pages: pass nextCursor back as cursor.
const page = await mgmt.projects.list({ label: 'env:preview', limit: 100 })
const next = page.nextCursor ? await mgmt.projects.list({ label: 'env:preview', limit: 100, cursor: page.nextCursor }) : null
```

Use a personal access token (`sdb_pat_…`, Account › Access tokens), an organization token (`sdb_org_…`), an OAuth access token or a short-lived project token (`sdb_prj_…`). These tokens can change and delete your projects, so only use them on a server.

Every method resolves to `{ data, error, status, nextCursor }` and does not throw. `error` is a `ManagementError` with the HTTP `status`, the server's message, and `code` and `hint` when the server sends them. SQL errors also carry the Postgres `code`, `detail` and `position`. Answers with status 429, 502 or 503 are retried up to 3 times and wait as long as `Retry-After` says (set `retries` to change the count). A request that fails on the network is sent again only for reads.

The methods are grouped by resource:

| Group | Methods |
| --- | --- |
| `projects` | `list`, `get`, `create`, `update`, `delete`, `pause`, `restore`, `apiKeys`, `rotateKeys`, `limits`, `updateLimits`, `usage`, `metrics` |
| `database` | `query`, `checkQuery`, `dump`, `types` (typescript, dart, swift, kotlin), `advisors`, `queryPerformance`, `resetQueryPerformance` |
| `migrations` | `list`, `apply` (`dryRun`), `check`, `repair` |
| `branches` | `list`, `create`, `get`, `delete`, `merge`, `masking`, `setMasking`, `maskingPreview` |
| `functions` / `secrets` | `list`, `get`, `deploy`, `update`, `delete`, `body`, `versions`, `logs`, `stats`, `usage` / `list`, `set`, `delete` |
| `webhooks` | `list`, `create`, `get`, `update`, `delete`, `secret`, `rotateSecret`, `test`, `deliveries`, `delivery`, `replay` |
| `logDrains`, `logs` | `list`, `create`, `update`, `delete`, `test` / `search`, `query` |
| `domains` | `list`, `get`, `add`, `check`, `update`, `delete` |
| `integrations` | `vercel.list`, `browse`, `link`, `update`, `sync`, `unlink`; `github.get`, `repositories`, `link`, `unlink` |
| `organizations` | `list`, `billing`, `usage`, `auditLog`, `members.*`, `invitations.*`, `tokens.*`, `apps.*`, `webhooks.*` |
| `tokens`, `claimLinks` | project tokens and claim links: `list`, `create`, `revoke` |
| `authConfig`, `graphql`, `networkRestrictions` | `get`, `update` / `get`, `set` / `get`, `set` |
| `regionMove`, `security`, `imports` | `get`, `start`, `cancel` / `exposure`, `settings`, `updateSettings` / `get`, `start`, `copy`, `cutover`, `undo`, `dismiss` |
| `agents` | `keys.*`, `dbLogins.*`, `audit`, `approvals.*` (`approve`, `reject`), `sessions.*` (`revert`) |
| `billing` | `estimate` |

Each method's doc comment names its endpoint. For any other endpoint, use `mgmt.request(method, path, { query, body })`. The full description is at `https://stitchdb.com/platform/v1/openapi.json` (`mgmt.openapi()`).

An AI agent that has an agent key (`sdb_agt_…`) uses its own client. Its SQL runs under the key's policy. A statement that needs a person's approval comes back with `status: 'pending_approval'`.

```ts
import { createAgentClient } from 'stitchdb-js/management'

const agent = createAgentClient({ agentKey: process.env.STITCHDB_AGENT_KEY! })
const { data } = await agent.sql('update orders set status = $$shipped$$ where id = 7', { session: 'run-1' })
if (data?.status === 'pending_approval') { /* poll agent.approval(data.approval_id) */ }
await agent.revert('run-1', { dry_run: false }) // undo everything the session changed
```

Without a bundler, import `https://stitchdb.com/sdk/stitchdb-management.mjs`.

## TypeScript

Generate types for your database and pass them to `createClient`:

```bash
stitchdb gen types typescript --linked > src/database.types.ts
```

```ts
import { createClient } from 'stitchdb-js'
import type { Database } from './database.types'

const stitchdb = createClient<Database>(url, anonKey)
const { data } = await stitchdb.from('todos').select('id, task') // data: { id: number; task: string }[] | null
```

## Browser script

```html
<script src="https://cdn.jsdelivr.net/npm/stitchdb-js@2/dist/stitchdb.js"></script>
<script>
  const client = stitchdb.createClient('https://<project-ref>.p.stitchdb.com', '<anon-key>')
</script>
```

## Upgrading from 1.x

2.0 is a drop-in upgrade. Signed-in users stay signed in: the saved session is moved to the new storage key (`stitchdb-<project-ref>-auth-token`) the first time it is read.

## Links

- Documentation: https://stitchdb.com/docs/sdk
- Dashboard: https://stitchdb.com/dashboard
- CLI: `npm install -g stitchdb-cli`

MIT License. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
