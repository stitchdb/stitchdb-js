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

Find the project URL (`https://<project-ref>.stitchdb.com`) and the anon key in the dashboard under **Settings → API keys**. The anon key is safe in browsers: Row Level Security decides what each user can read and write. Use the service_role key only on servers you control.

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
  const client = stitchdb.createClient('https://<project-ref>.stitchdb.com', '<anon-key>')
</script>
```

## Upgrading from 1.x

2.0 is a drop-in upgrade. Signed-in users stay signed in: the saved session is moved to the new storage key (`stitchdb-<project-ref>-auth-token`) the first time it is read.

## Links

- Documentation: https://stitchdb.com/docs/sdk
- Dashboard: https://stitchdb.com/dashboard
- CLI: `npm install -g stitchdb-cli`

MIT License. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
