# stitchdb-js

The official JavaScript and TypeScript client for [StitchDB](https://stitchdb.com): Postgres database, auth, storage, realtime and Edge Functions.

```bash
npm install stitchdb-js
```

```js
import { createClient } from 'stitchdb-js'

const stitchdb = createClient('https://<project-ref>.stitchdb.com', '<anon-key>')

const { data, error } = await stitchdb.from('todos').select('*').limit(10)
await stitchdb.auth.signInWithPassword({ email, password })
stitchdb.channel('room-1').on('broadcast', { event: 'cursor' }, (p) => console.log(p)).subscribe()
await stitchdb.storage.from('avatars').upload('user-1/avatar.png', file)
const { data: fn } = await stitchdb.functions.invoke('hello-world', { body: { name: 'Ada' } })
```

Find your project URL and anon key in the dashboard under **Settings → API keys**.

Documentation: https://stitchdb.com/docs/sdk
