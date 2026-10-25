import type { AuthChangeEvent } from './auth/index'
import { FunctionsClient } from './functions/index'
import { PushClient } from './push'
import { PurchasesClient } from './purchases'
import { OrgsClient } from './orgs'
import { withHistory } from './realtime-history'
import {
  PostgrestClient,
  type PostgrestFilterBuilder,
  type PostgrestOpenApiSpec,
  type PostgrestQueryBuilder,
  type PostgrestSingleResponse,
} from './postgrest/index'
import {
  type RealtimeChannel,
  type RealtimeChannelOptions,
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeRemoveChannelResponse,
} from './realtime/index'
import { StorageClient as StitchStorageClient } from './storage/index'
import {
  DEFAULT_AUTH_OPTIONS,
  DEFAULT_DB_OPTIONS,
  DEFAULT_GLOBAL_OPTIONS,
  DEFAULT_REALTIME_OPTIONS,
  DEFAULT_TRACE_PROPAGATION_OPTIONS,
} from './lib/constants'
import { checkApiKeyFormat, fetchWithAuth } from './lib/fetch'
import { withLegacyStorageKey } from './lib/legacy-storage'
import {
  applySettingDefaults,
  checkTopLevelSchemaOption,
  validateStitchUrl,
  type ResolvedStitchClientOptions,
} from './lib/helpers'
import { StitchAuthClient } from './lib/StitchAuthClient'
import type {
  Fetch,
  GenericSchema,
  StitchAuthClientOptions,
  StitchClientOptions,
} from './lib/types'
import { GetRpcFunctionFilterBuilderByArgs } from './lib/rest/types/common/rpc'

/**
 * StitchDB Client.
 *
 * An isomorphic Javascript client for interacting with Postgres.
 */
export default class StitchClient<
  Database = any,
  // The second type parameter is also used for specifying db_schema, so we
  // support both cases.
  // TODO: Allow setting db_schema from ClientOptions.
  SchemaNameOrClientOptions extends
    | (string & keyof Omit<Database, '__InternalStitch'>)
    | { PostgrestVersion: string } = 'public' extends keyof Omit<Database, '__InternalStitch'>
    ? 'public'
    : string & keyof Omit<Database, '__InternalStitch'>,
  SchemaName extends string & keyof Omit<Database, '__InternalStitch'> =
    SchemaNameOrClientOptions extends string & keyof Omit<Database, '__InternalStitch'>
      ? SchemaNameOrClientOptions
      : 'public' extends keyof Omit<Database, '__InternalStitch'>
        ? 'public'
        : string & keyof Omit<Omit<Database, '__InternalStitch'>, '__InternalStitch'>,
  Schema extends Omit<Database, '__InternalStitch'>[SchemaName] extends GenericSchema
    ? Omit<Database, '__InternalStitch'>[SchemaName]
    : never = Omit<Database, '__InternalStitch'>[SchemaName] extends GenericSchema
    ? Omit<Database, '__InternalStitch'>[SchemaName]
    : never,
  ClientOptions extends { PostgrestVersion: string } = SchemaNameOrClientOptions extends string &
    keyof Omit<Database, '__InternalStitch'>
    ? // If the version isn't explicitly set, look for it in the __InternalStitch object to infer the right version
      Database extends { __InternalStitch: { PostgrestVersion: string } }
      ? Database['__InternalStitch']
      : // otherwise default to 12
        { PostgrestVersion: '12' }
    : SchemaNameOrClientOptions extends { PostgrestVersion: string }
      ? SchemaNameOrClientOptions
      : never,
> {
  /**
   * StitchDB Auth allows you to create and manage user sessions for access to data that is secured by access policies.
   */
  auth: StitchAuthClient
  realtime: RealtimeClient
  /**
   * StitchDB Storage allows you to manage user-generated content, such as photos or videos.
   */
  storage: StitchStorageClient

  protected realtimeUrl: URL
  protected authUrl: URL
  protected storageUrl: URL
  protected functionsUrl: URL
  protected pushUrl: URL
  protected purchasesUrl: URL
  protected historyUrl: URL
  protected rest: PostgrestClient<Database, ClientOptions, SchemaName>
  protected storageKey: string
  protected fetch?: Fetch
  protected functionsFetch?: Fetch
  protected changedAccessToken?: string
  protected accessToken?: () => Promise<string | null>

  protected headers: Record<string, string>
  protected settings?: ResolvedStitchClientOptions<SchemaName>

  /**
   * Create a new client for use in the browser.
   *
   * @category Initializing
   *
   * @param stitchUrl The unique StitchDB URL which is supplied when you create a new project in your project dashboard.
   * @param stitchKey The unique StitchDB Key which is supplied when you create a new project in your project dashboard.
   * @param options Optional configuration for the client:
   * - `db.schema` — You can switch in between schemas. The schema needs to be on the list of exposed schemas inside StitchDB.
   * - `auth.autoRefreshToken` — Set to `true` if you want to automatically refresh the token before expiring.
   * - `auth.persistSession` — Set to `true` if you want to automatically save the user session into local storage.
   * - `auth.detectSessionInUrl` — Set to `true` if you want to automatically detect OAuth grants in the URL and sign in the user.
   * - `realtime` — Options passed along to the realtime-js constructor.
   * - `storage` — Options passed along to the storage-js constructor.
   * - `global.fetch` — A custom fetch implementation.
   * - `global.headers` — Any additional headers to send with each network request.
   *
   * @example Creating a client
   * ```js
   * import { createClient } from 'stitchdb-js'
   *
   * // Create a single stitchdb client for interacting with your database
   * const stitchdb = createClient('https://<project-ref>.p.stitchdb.com', 'your-anon-key')
   * ```
   *
   * @example With a custom domain
   * ```js
   * import { createClient } from 'stitchdb-js'
   *
   * // Use a custom domain as the stitchdb URL
   * const stitchdb = createClient('https://my-custom-domain.com', 'your-anon-key')
   * ```
   *
   * @example With additional parameters
   * ```js
   * import { createClient } from 'stitchdb-js'
   *
   * const options = {
   *   db: {
   *     schema: 'public',
   *   },
   *   auth: {
   *     autoRefreshToken: true,
   *     persistSession: true,
   *     detectSessionInUrl: true
   *   },
   *   global: {
   *     headers: { 'x-my-custom-header': 'my-app-name' },
   *   },
   * }
   * const stitchdb = createClient("https://<project-ref>.p.stitchdb.com", "your-anon-key", options)
   * ```
   *
   * @exampleDescription With custom schemas
   * The StitchDB REST API serves the `public` schema. Keep tables you want to reach through the API in `public`
   * (other schemas are only reachable over a direct Postgres connection). The `db.schema` option exists for API
   * servers that expose more schemas.
   *
   * @example With custom schemas
   * ```js
   * import { createClient } from 'stitchdb-js'
   *
   * const stitchdb = createClient('https://<project-ref>.p.stitchdb.com', 'your-anon-key', {
   *   // Provide a custom schema. Defaults to "public".
   *   db: { schema: 'other_schema' }
   * })
   * ```
   *
   * @exampleDescription Custom fetch implementation
   * `stitchdb-js` uses the runtime's global `fetch` to make HTTP requests,
   * but an alternative `fetch` implementation can be provided as an option.
   * This is useful in environments where the global `fetch` is unavailable or where you want to customize request behavior.
   *
   * @example Custom fetch implementation
   * ```js
   * import { createClient } from 'stitchdb-js'
   *
   * const stitchdb = createClient('https://<project-ref>.p.stitchdb.com', 'your-anon-key', {
   *   global: { fetch: fetch.bind(globalThis) }
   * })
   * ```
   *
   * @exampleDescription React Native options with AsyncStorage
   * For React Native we recommend using `AsyncStorage` as the storage implementation for StitchDB Auth.
   *
   * @example React Native options with AsyncStorage
   * ```js
   * import 'react-native-url-polyfill/auto'
   * import { createClient } from 'stitchdb-js'
   * import AsyncStorage from "@react-native-async-storage/async-storage";
   *
   * const stitchdb = createClient("https://<project-ref>.p.stitchdb.com", "your-anon-key", {
   *   auth: {
   *     storage: AsyncStorage,
   *     autoRefreshToken: true,
   *     persistSession: true,
   *     detectSessionInUrl: false,
   *   },
   * });
   * ```
   *
   * @exampleDescription React Native options with Expo SecureStore
   * If you wish to encrypt the user's session information, you can use `aes-js` and store the encryption key in Expo SecureStore.
   * The `aes-js` library, a reputable JavaScript-only implementation of the AES encryption algorithm in CTR mode.
   * A new 256-bit encryption key is generated using the `react-native-get-random-values` library.
   * This key is stored inside Expo's SecureStore, while the value is encrypted and placed inside AsyncStorage.
   *
   * Please make sure that:
   * - You keep the `expo-secure-store`, `aes-js` and `react-native-get-random-values` libraries up-to-date.
   * - Choose the correct [`SecureStoreOptions`](https://docs.expo.dev/versions/latest/sdk/securestore/#securestoreoptions) for your app's needs.
   *   E.g. [`SecureStore.WHEN_UNLOCKED`](https://docs.expo.dev/versions/latest/sdk/securestore/#securestorewhen_unlocked) regulates when the data can be accessed.
   * - Carefully consider optimizations or other modifications to the above example, as those can lead to introducing subtle security vulnerabilities.
   *
   * @example React Native options with Expo SecureStore
   * ```ts
   * import 'react-native-url-polyfill/auto'
   * import { createClient } from 'stitchdb-js'
   * import AsyncStorage from '@react-native-async-storage/async-storage';
   * import * as SecureStore from 'expo-secure-store';
   * import * as aesjs from 'aes-js';
   * import 'react-native-get-random-values';
   *
   * // As Expo's SecureStore does not support values larger than 2048
   * // bytes, an AES-256 key is generated and stored in SecureStore, while
   * // it is used to encrypt/decrypt values stored in AsyncStorage.
   * class LargeSecureStore {
   *   private async _encrypt(key: string, value: string) {
   *     const encryptionKey = crypto.getRandomValues(new Uint8Array(256 / 8));
   *
   *     const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
   *     const encryptedBytes = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
   *
   *     await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey));
   *
   *     return aesjs.utils.hex.fromBytes(encryptedBytes);
   *   }
   *
   *   private async _decrypt(key: string, value: string) {
   *     const encryptionKeyHex = await SecureStore.getItemAsync(key);
   *     if (!encryptionKeyHex) {
   *       return encryptionKeyHex;
   *     }
   *
   *     const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(encryptionKeyHex), new aesjs.Counter(1));
   *     const decryptedBytes = cipher.decrypt(aesjs.utils.hex.toBytes(value));
   *
   *     return aesjs.utils.utf8.fromBytes(decryptedBytes);
   *   }
   *
   *   async getItem(key: string) {
   *     const encrypted = await AsyncStorage.getItem(key);
   *     if (!encrypted) { return encrypted; }
   *
   *     return await this._decrypt(key, encrypted);
   *   }
   *
   *   async removeItem(key: string) {
   *     await AsyncStorage.removeItem(key);
   *     await SecureStore.deleteItemAsync(key);
   *   }
   *
   *   async setItem(key: string, value: string) {
   *     const encrypted = await this._encrypt(key, value);
   *
   *     await AsyncStorage.setItem(key, encrypted);
   *   }
   * }
   *
   * const stitchdb = createClient("https://<project-ref>.p.stitchdb.com", "your-anon-key", {
   *   auth: {
   *     storage: new LargeSecureStore(),
   *     autoRefreshToken: true,
   *     persistSession: true,
   *     detectSessionInUrl: false,
   *   },
   * });
   * ```
   *
   * @example With a database query
   * ```ts
   * import { createClient } from 'stitchdb-js'
   *
   * const stitchdb = createClient('https://<project-ref>.p.stitchdb.com', 'your-anon-key')
   *
   * const { data } = await stitchdb.from('profiles').select('*')
   * ```
   *
   * @exampleDescription With OpenTelemetry tracing
   * Opt in to W3C trace context propagation so the `trace_id` from your
   * client-side spans is attached to StitchDB requests and appears in API
   * Gateway and Edge Function logs. Requires `@opentelemetry/api` to be
   * installed in your application and the tracing runtime to be loaded via
   * `import 'stitchdb-js/tracing'`. See [Tracing with the JS SDK](https://stitchdb.com/docs).
   *
   * @example With OpenTelemetry tracing
   * ```ts
   * import 'stitchdb-js/tracing'
   * import { createClient } from 'stitchdb-js'
   * import { trace } from '@opentelemetry/api'
   *
   * const stitchdb = createClient('https://<project-ref>.p.stitchdb.com', 'your-anon-key', {
   *   tracePropagation: true,
   * })
   *
   * const tracer = trace.getTracer('my-app')
   *
   * await tracer.startActiveSpan('fetch-users', async (span) => {
   *   // Outgoing request carries the active trace context.
   *   const { data, error } = await stitchdb.from('users').select('*')
   *   span.end()
   * })
   * ```
   */
  constructor(
    protected stitchUrl: string,
    protected stitchKey: string,
    options?: StitchClientOptions<SchemaName>
  ) {
    const baseUrl = validateStitchUrl(stitchUrl)
    if (!stitchKey) throw new Error('stitchKey is required.')
    checkApiKeyFormat(stitchKey)
    checkTopLevelSchemaOption(options)

    this.realtimeUrl = new URL('realtime/v1', baseUrl)
    this.realtimeUrl.protocol = this.realtimeUrl.protocol.replace('http', 'ws')
    this.authUrl = new URL('auth/v1', baseUrl)
    this.storageUrl = new URL('storage/v1', baseUrl)
    this.functionsUrl = new URL('functions/v1', baseUrl)
    this.pushUrl = new URL('push/v1', baseUrl)
    this.purchasesUrl = new URL('purchases/v1', baseUrl)
    this.historyUrl = new URL('history/v1', baseUrl)

    // default storage key uses the project ref as a namespace
    const projectRef = baseUrl.hostname.split('.')[0]
    const defaultStorageKey = `stitchdb-${projectRef}-auth-token`
    const DEFAULTS = {
      db: DEFAULT_DB_OPTIONS,
      realtime: DEFAULT_REALTIME_OPTIONS,
      auth: { ...DEFAULT_AUTH_OPTIONS, storageKey: defaultStorageKey },
      global: DEFAULT_GLOBAL_OPTIONS,
      tracePropagation: DEFAULT_TRACE_PROPAGATION_OPTIONS,
    }

    const settings = applySettingDefaults(options ?? {}, DEFAULTS)
    this.settings = settings

    // Sessions saved by earlier SDK versions under the previous key name are moved over on first
    // read, so upgrading never signs anyone out (only when the default storage key is in use).
    if (!options?.auth?.storageKey && settings.auth) {
      settings.auth.storage = withLegacyStorageKey(settings.auth.storage, defaultStorageKey, `sb-${projectRef}-auth-token`)
    }
    this.storageKey = settings.auth.storageKey ?? ''
    this.headers = settings.global.headers ?? {}

    if (!settings.accessToken) {
      this.auth = this._initStitchAuthClient(
        settings.auth ?? {},
        this.headers,
        settings.global.fetch
      )
    } else {
      this.accessToken = settings.accessToken

      this.auth = new Proxy<StitchAuthClient>({} as any, {
        get: (_, prop) => {
          throw new Error(
            `stitchdb-js: StitchDB Client is configured with the accessToken option, accessing stitchdb.auth.${String(
              prop
            )} is not possible`
          )
        },
      })
    }

    // The fetch wrappers receive the raw session token (null when there is no session) and
    // decide the `Authorization` fallback themselves, so the API-key fallback lives in one place.
    this.fetch = fetchWithAuth(
      stitchKey,
      stitchUrl,
      this._getSessionToken.bind(this),
      settings.global.fetch,
      settings.tracePropagation
    )
    // Edge Functions use a dedicated fetch that never falls back to a new-format API key in
    // the Authorization header (see `isNewApiKey` in ./lib/fetch). Other services use `this.fetch`.
    this.functionsFetch = fetchWithAuth(
      stitchKey,
      stitchUrl,
      this._getSessionToken.bind(this),
      settings.global.fetch,
      settings.tracePropagation,
      { omitApiKeyAsBearer: true }
    )
    this.realtime = this._initRealtimeClient({
      headers: this.headers,
      accessToken: this._getAccessToken.bind(this),
      fetch: this.fetch,
      ...settings.realtime,
    })
    if (this.accessToken) {
      // Start auth immediately to avoid race condition with channel subscriptions
      // Wrap Promise to avoid Firefox extension cross-context Promise access errors
      Promise.resolve(this.accessToken())
        .then((token) => this.realtime.setAuth(token))
        .catch((e) => console.warn('Failed to set initial Realtime auth token:', e))
    }

    this.rest = new PostgrestClient(new URL('rest/v1', baseUrl).href, {
      headers: this.headers,
      schema: settings.db.schema,
      fetch: this.fetch,
      timeout: settings.db.timeout,
      urlLengthLimit: settings.db.urlLengthLimit,
      retry: settings.db.retry,
    })

    this.storage = new StitchStorageClient(
      this.storageUrl.href,
      this.headers,
      this.fetch,
      options?.storage
    )

    if (!settings.accessToken) {
      this._listenForAuthEvents()
    }
  }

  /**
   * StitchDB Functions allows you to deploy and invoke edge functions.
   */
  get functions(): FunctionsClient {
    return new FunctionsClient(this.functionsUrl.href, {
      headers: this.headers,
      customFetch: this.functionsFetch,
    })
  }

  /**
   * Push notifications and the in-app inbox: register devices, subscribe to topics, read the inbox,
   * and (with the service role key) send.
   */
  get push(): PushClient {
    return new PushClient(
      this.pushUrl.href,
      this.fetch!,
      (name) => this.channel(name) as any,
      (ch) => this.removeChannel(ch as any),
      async () => (await this.auth.getSession()).data.session?.user?.id ?? null
    )
  }

  /**
   * In-app purchases: send App Store / Google Play purchases to be checked with the store, read the user's
   * purchases and entitlements.
   */
  get purchases(): PurchasesClient {
    return new PurchasesClient(this.purchasesUrl.href, this.fetch!)
  }

  /**
   * Organizations (teams, workspaces) for your app's users: create, invite by e-mail, roles, the active
   * organization. Turn it on in Studio → Authentication → Organizations.
   */
  get orgs(): OrgsClient {
    return new OrgsClient(
      (fn, args) => this.rpc(fn as any, args as any) as any,
      async () => {
        const { data } = await this.auth.getSession()
        if (data.session) await this.auth.refreshSession()
      }
    )
  }

  // NOTE: signatures must be kept in sync with PostgrestClient.from
  from<
    TableName extends string & keyof Schema['Tables'],
    Table extends Schema['Tables'][TableName],
  >(relation: TableName): PostgrestQueryBuilder<ClientOptions, Schema, Table, TableName>
  from<ViewName extends string & keyof Schema['Views'], View extends Schema['Views'][ViewName]>(
    relation: ViewName
  ): PostgrestQueryBuilder<ClientOptions, Schema, View, ViewName>
  /**
   * Perform a query on a table or a view.
   *
   * @param relation - The table or view name to query
   */
  from(relation: string): PostgrestQueryBuilder<ClientOptions, Schema, any> {
    return this.rest.from(relation)
  }

  // NOTE: signatures must be kept in sync with PostgrestClient.schema
  /**
   * Select a schema to query or perform an function (rpc) call.
   *
   * The schema needs to be on the list of exposed schemas inside StitchDB.
   *
   * @param schema - The schema to query
   */
  schema<DynamicSchema extends string & keyof Omit<Database, '__InternalStitch'>>(
    schema: DynamicSchema
  ): PostgrestClient<
    Database,
    ClientOptions,
    DynamicSchema,
    Database[DynamicSchema] extends GenericSchema ? Database[DynamicSchema] : any
  > {
    return this.rest.schema<DynamicSchema>(schema)
  }

  // NOTE: signatures must be kept in sync with PostgrestClient.getOpenApiSpec
  /**
   * Fetch the OpenAPI description PostgREST publishes for this client's schema.
   *
   * The document lists only the tables, views and functions the caller's role
   * holds privileges on. The request carries the same `apikey` and
   * `Authorization` headers as every other query, so the description is scoped
   * to the signed-in user. Call `.schema()` first to describe a schema other
   * than the client default.
   *
   * @example
   * ```ts
   * const { data, error } = await stitchdb.getOpenApiSpec()
   * ```
   */
  getOpenApiSpec(): Promise<PostgrestSingleResponse<PostgrestOpenApiSpec>> {
    return this.rest.getOpenApiSpec()
  }

  // NOTE: signatures must be kept in sync with PostgrestClient.rpc
  /**
   * Perform a function call.
   *
   * @param fn - The function name to call
   * @param args - The arguments to pass to the function call
   * @param options - Named parameters
   * @param options.head - When set to `true`, `data` will not be returned.
   * Useful if you only need the count.
   * @param options.get - When set to `true`, the function will be called with
   * read-only access mode.
   * @param options.count - Count algorithm to use to count rows returned by the
   * function. Only applicable for [set-returning
   * functions](https://www.postgresql.org/docs/current/functions-srf.html).
   *
   * `"exact"`: Exact but slow count algorithm. Performs a `COUNT(*)` under the
   * hood.
   *
   * `"planned"`: Approximated but fast count algorithm. Uses the Postgres
   * statistics under the hood.
   *
   * `"estimated"`: Uses exact count for low numbers and planned count for high
   * numbers.
   */
  rpc<
    FnName extends string & keyof Schema['Functions'],
    Args extends Schema['Functions'][FnName]['Args'] = never,
    FilterBuilder extends GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args> =
      GetRpcFunctionFilterBuilderByArgs<Schema, FnName, Args>,
  >(
    fn: FnName,
    args: Args = {} as Args,
    options: {
      head?: boolean
      get?: boolean
      count?: 'exact' | 'planned' | 'estimated'
    } = {
      head: false,
      get: false,
      count: undefined,
    }
  ): PostgrestFilterBuilder<
    ClientOptions,
    Schema,
    FilterBuilder['Row'],
    FilterBuilder['Result'],
    FilterBuilder['RelationName'],
    FilterBuilder['Relationships'],
    'RPC'
  > {
    return this.rest.rpc(fn, args, options) as unknown as PostgrestFilterBuilder<
      ClientOptions,
      Schema,
      FilterBuilder['Row'],
      FilterBuilder['Result'],
      FilterBuilder['RelationName'],
      FilterBuilder['Relationships'],
      'RPC'
    >
  }

  /**
   * Creates a Realtime channel with Broadcast, Presence, and Postgres Changes.
   *
   * @param {string} name - The name of the Realtime channel.
   * @param {Object} opts - The options to pass to the Realtime channel.
   *
   * @category Realtime
   */
  channel(name: string, opts: RealtimeChannelOptions = { config: {} }): RealtimeChannel {
    const ch = this.realtime.channel(name, opts)
    // A channel joins with the token the socket holds at that moment. Right after a sign-in that can
    // still be the anon key (the session token reaches the socket a moment later), so changes on RLS
    // tables would be evaluated as `anon` and never delivered. Load the current session token into
    // the socket before the first join of each channel.
    if (!this.accessToken) {
      const subscribe = ch.subscribe.bind(ch)
      let first = true
      ch.subscribe = ((callback?: Parameters<RealtimeChannel['subscribe']>[0], timeout?: number) => {
        if (!first) return subscribe(callback, timeout)
        first = false
        this._getAccessToken()
          .then((token) => this.realtime.setAuth(token))
          .catch(() => {})
          .then(() => subscribe(callback, timeout))
        return ch
      }) as RealtimeChannel['subscribe']
    }
    const history = opts.config?.history
    if (history) {
      withHistory(ch, history, {
        url: this.historyUrl.href,
        fetch: this.fetch!,
        headers: async () => ({ apikey: this.stitchKey, Authorization: `Bearer ${await this._getAccessToken()}` }),
      })
    }
    return ch
  }

  /**
   * Returns all Realtime channels.
   *
   * @category Realtime
   *
   * @example Get all channels
   * ```js
   * const channels = stitchdb.getChannels()
   * ```
   */
  getChannels(): RealtimeChannel[] {
    return this.realtime.getChannels()
  }

  /**
   * Unsubscribes and removes Realtime channel from Realtime client.
   *
   * @param {RealtimeChannel} channel - The name of the Realtime channel.
   *
   *
   * @category Realtime
   *
   * @remarks
   * - Removing a channel is a great way to maintain the performance of your project's Realtime service as well as your database if you're listening to Postgres changes. StitchDB will automatically handle cleanup 30 seconds after a client is disconnected, but unused channels may cause degradation as more clients are simultaneously subscribed.
   *
   * @example Removes a channel
   * ```js
   * stitchdb.removeChannel(myChannel)
   * ```
   */
  removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse> {
    return this.realtime.removeChannel(channel)
  }

  /**
   * Unsubscribes and removes all Realtime channels from Realtime client.
   *
   * @category Realtime
   *
   * @remarks
   * - Removing channels is a great way to maintain the performance of your project's Realtime service as well as your database if you're listening to Postgres changes. StitchDB will automatically handle cleanup 30 seconds after a client is disconnected, but unused channels may cause degradation as more clients are simultaneously subscribed.
   *
   * @example Remove all channels
   * ```js
   * stitchdb.removeAllChannels()
   * ```
   */
  removeAllChannels(): Promise<RealtimeRemoveChannelResponse[]> {
    return this.realtime.removeAllChannels()
  }

  /**
   * The raw session token — the custom `accessToken` result or the signed-in user's JWT —
   * or `null` when there is no session. Unlike {@link _getAccessToken} it does not fall back
   * to `stitchKey`, so callers can distinguish "no session" from "has session".
   */
  private async _getSessionToken(): Promise<string | null> {
    if (this.accessToken) {
      return await this.accessToken()
    }

    const { data } = await this.auth.getSession()

    return data.session?.access_token ?? null
  }

  private async _getAccessToken() {
    return (await this._getSessionToken()) ?? this.stitchKey
  }

  private _initStitchAuthClient(
    {
      autoRefreshToken,
      persistSession,
      detectSessionInUrl,
      storage,
      userStorage,
      storageKey,
      flowType,
      lock,
      debug,
      throwOnError,
      experimental,
      lockAcquireTimeout,
      skipAutoInitialize,
    }: StitchAuthClientOptions,
    headers?: Record<string, string>,
    fetch?: Fetch
  ) {
    const authHeaders = {
      Authorization: `Bearer ${this.stitchKey}`,
      apikey: `${this.stitchKey}`,
    }
    return new StitchAuthClient({
      url: this.authUrl.href,
      headers: { ...authHeaders, ...headers },
      storageKey: storageKey,
      autoRefreshToken,
      persistSession,
      detectSessionInUrl,
      storage,
      userStorage,
      flowType,
      lock,
      debug,
      throwOnError,
      experimental,
      fetch,
      lockAcquireTimeout,
      skipAutoInitialize,
      // auth checks if there is a custom authorizaiton header using this flag
      // so it knows whether to return an error when getUser is called with no session
      hasCustomAuthorizationHeader: Object.keys(this.headers).some(
        (key) => key.toLowerCase() === 'authorization'
      ),
    })
  }

  private _initRealtimeClient(options: RealtimeClientOptions) {
    return new RealtimeClient(this.realtimeUrl.href, {
      ...options,
      params: { ...{ apikey: this.stitchKey }, ...options?.params },
    })
  }

  private _listenForAuthEvents() {
    const data = this.auth.onAuthStateChange((event, session) => {
      this._handleTokenChanged(event, 'CLIENT', session?.access_token)
    })
    return data
  }

  private _handleTokenChanged(
    event: AuthChangeEvent,
    source: 'CLIENT' | 'STORAGE',
    token?: string
  ) {
    if (
      (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') &&
      this.changedAccessToken !== token
    ) {
      this.changedAccessToken = token
      this.realtime.setAuth(token)
    } else if (event === 'SIGNED_OUT') {
      this.realtime.setAuth()
      if (source == 'STORAGE') this.auth.signOut()
      this.changedAccessToken = undefined
    }
  }
}
