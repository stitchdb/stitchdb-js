// StitchDB JavaScript SDK type declarations.
export interface StitchClientOptions {
  auth?: { persistSession?: boolean; autoRefreshToken?: boolean; detectSessionInUrl?: boolean; storage?: any; storageKey?: string; flowType?: 'implicit' | 'pkce' }
  db?: { schema?: string }
  global?: { headers?: Record<string, string>; fetch?: typeof fetch }
  realtime?: Record<string, any>
}
export type StitchClient = any
export declare function createClient(url: string, key: string, options?: StitchClientOptions): StitchClient
