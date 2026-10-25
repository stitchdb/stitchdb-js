import StitchClient from './StitchClient'
import type { StitchClientOptions } from './lib/types'

export * from './auth/index'
export type { User as AuthUser, Session as AuthSession } from './auth/index'
export type {
  PostgrestResponse,
  PostgrestSingleResponse,
  PostgrestMaybeSingleResponse,
  PostgrestOpenApiSpec,
  PostgrestBuilder,
  PostgrestFilterBuilder,
  PostgrestTransformBuilder,
  PostgrestQueryBuilder,
} from './postgrest/index'
export { PostgrestError } from './postgrest/index'
export { StorageApiError } from './storage/index'
export type { FunctionInvokeOptions } from './functions/index'
export {
  FunctionsHttpError,
  FunctionsFetchError,
  FunctionsRelayError,
  FunctionsError,
  FunctionRegion,
} from './functions/index'
export * from './realtime/index'
export { default as StitchClient } from './StitchClient'
export { PushClient, PushError } from './push'
export type { PushDevice, PushMessage, InboxNotification } from './push'
export type {
  StitchClientOptions,
  TracePropagationOptions,
  QueryResult,
  QueryData,
  QueryError,
  DatabaseWithoutInternals,
} from './lib/types'

/**
 * Creates a new StitchDB Client.
 *
 * @example Creating a StitchDB client
 * ```ts
 * import { createClient } from 'stitchdb-js'
 *
 * const stitchdb = createClient('https://<project-ref>.p.stitchdb.com', 'your-anon-key')
 * const { data, error } = await stitchdb.from('profiles').select('*')
 * ```
 */
export const createClient = <
  Database = any,
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
>(
  stitchUrl: string,
  stitchKey: string,
  options?: StitchClientOptions<SchemaName>
): StitchClient<Database, SchemaNameOrClientOptions, SchemaName> => {
  return new StitchClient<Database, SchemaNameOrClientOptions, SchemaName>(
    stitchUrl,
    stitchKey,
    options
  )
}
