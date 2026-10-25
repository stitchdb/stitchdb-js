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

### Edge Functions

```js
const { data, error } = await stitchdb.functions.invoke('hello-world', { body: { name: 'Ada' } })
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
