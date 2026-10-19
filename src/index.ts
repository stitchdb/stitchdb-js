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
 * const stitchdb = createClient('https://xyzcompany.stitchdb.com', 'your-publishable-key')
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

// Check for Node.js <= 20 deprecation
function shouldShowDeprecationWarning(): boolean {
  // Skip in browser and Deno environments
  if (typeof window !== 'undefined' || (globalThis as any)['Deno'] !== undefined) {
    return false
  }

  // Skip if process is not available (e.g., Edge Runtime)
  // Use dynamic property access to avoid Next.js Edge Runtime static analysis warnings
  const _process = (globalThis as any)['process']
  if (!_process) {
    return false
  }

  const processVersion = _process['version']
  if (processVersion === undefined || processVersion === null) {
    return false
  }

  const versionMatch = processVersion.match(/^v(\d+)\./)
  if (!versionMatch) {
    return false
  }

  const majorVersion = parseInt(versionMatch[1], 10)
  return majorVersion <= 20
}

if (shouldShowDeprecationWarning()) {
  console.warn(
    `⚠️  Node.js 20 and below are deprecated and will no longer be supported in future versions of stitchdb-js. ` +
      `Please upgrade to Node.js 22 or later. ` +
      `For more information, visit: https://github.com/orgs/stitchdb/discussions/45715`
  )
}
