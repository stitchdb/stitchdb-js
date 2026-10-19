// StitchDB JavaScript SDK: database, auth, storage and realtime clients for a StitchDB project.
import { createClient as baseCreateClient } from '@supabase/supabase-js'
export * from '@supabase/supabase-js'

// Realtime joins a channel with whatever token the socket holds at that moment. Right after signIn that is still the
// anon key (the session token is only pushed later), so postgres_changes on RLS tables were evaluated as `anon` and
// delivered nothing. Fetch the current session token before the first join of each channel.
export function createClient(url, key, options) {
  const client = baseCreateClient(url, key, options)
  const channel = client.channel.bind(client)
  client.channel = (name, opts) => {
    const ch = channel(name, opts)
    const subscribe = ch.subscribe.bind(ch)
    ch.subscribe = (callback, timeout) => {
      if (ch.joinedOnce) return subscribe(callback, timeout)
      Promise.resolve().then(() => client.realtime.setAuth()).catch(() => {}).then(() => subscribe(callback, timeout))
      return ch
    }
    return ch
  }
  return client
}
