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
export { SearchError } from './search'
export { OfflineClient, OfflineTable, OfflineError, MemoryStore, IndexedDBStore } from './offline'
export type { OfflineOptions, OfflineStore, SyncStatus, ConflictEvent } from './offline'
export { CollabClient, CollabRoom, CollabError } from './collab'
export type { CollabOptions, OpenOptions as CollabOpenOptions, CollabStatus, YModule, SnapshotInfo, DocumentInfo as CollabDocument } from './collab'
export { JobsClient, JobsError } from './jobs'
export { FlagsClient, FlagsError } from './flags'
export type { FlagValue, FlagAttributes, FlagsLoadOptions, FlagUser } from './flags'
export { MeteringClient, MeteringError } from './metering'
export { CrashesClient, CrashesError } from './crashes'
export type { CrashesOptions, CrashReport, Breadcrumb, CrashIssue, CrashIssueStatus, CrashIssueDetail, CrashEvent, CrashReleases, SourceMap } from './crashes'
export { AnalyticsClient, AnalyticsError } from './analytics'
export type { AnalyticsOptions, AnalyticsEvent, AnalyticsOverview, AnalyticsTrendQuery, AnalyticsTrend, AnalyticsFunnel, AnalyticsRetention, AnalyticsUserEvents } from './analytics'
export { GraphQLError } from './graphql'
export type { GraphQLOptions, GraphQLResult, GraphQLErrorItem } from './graphql'
export { HeartbeatClient, HeartbeatError } from './heartbeat'
export type { PingOptions, Monitor, MonitorRun } from './heartbeat'
export { StatusClient, StatusError } from './status'
export type { StatusSummary, StatusComponent, StatusIncident, ComponentStatus } from './status'
export { LinksClient, LinksError } from './links'
export type { AppLink, Link, LinkInput, LinkStats } from './links'
export type { MeterEvent, UsageRow, UsageQuery, UsageResult, CustomerTotals, StripeCustomer, MeterAlert } from './metering'
export type { JobRunInfo, JobStatus, StartOptions, JobLogLine } from './jobs'
export type { SearchOptions, SearchResponse, SearchScore } from './search'
export { PurchasesClient, PurchasesError } from './purchases'
export type { PurchaseInput, Purchase } from './purchases'
export { OrgsClient, OrgsError } from './orgs'
export type { Org, OrgMember, OrgInvite } from './orgs'
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
