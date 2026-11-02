/**
 * GraphQL API: queries and mutations over the project's tables at `https://<ref>.<zone>/graphql/v1`. Turn it on in
 * Studio › API › GraphQL. The same API keys and row level security as the REST API apply: signed in, the query runs as
 * the user.
 *
 * @example
 * ```ts
 * const { data, error } = await stitchdb.graphql(`
 *   query Todos($done: Boolean) {
 *     todosCollection(filter: { is_complete: { eq: $done } }, first: 20) { edges { node { id task } } }
 *   }`, { variables: { done: false } })
 * ```
 *
 * @module graphql
 */
import type { Fetch } from './lib/types'

/** One entry of a GraphQL response's `errors`. */
export type GraphQLErrorItem = { message: string; locations?: { line: number; column: number }[]; path?: (string | number)[]; extensions?: Record<string, unknown> }

export class GraphQLError extends Error {
  constructor(message: string, public status: number, public errors: GraphQLErrorItem[] = []) { super(message); this.name = 'GraphQLError' }
}

export type GraphQLOptions = {
  variables?: Record<string, unknown>
  /** Which operation to run when the document has several. */
  operationName?: string
  /** Extra request headers (for example another user's `Authorization` on a server). */
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * `data` is what the server answered (it can be partial when some fields failed), `errors` the GraphQL errors as sent.
 * `error` is set when the request failed (network, HTTP status, API turned off) or the response has errors.
 */
export type GraphQLResult<T> = { data: T | null; errors?: GraphQLErrorItem[]; error: GraphQLError | null }

export async function graphql<T = any>(url: string, fetch: Fetch, query: string, options: GraphQLOptions = {}): Promise<GraphQLResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
      body: JSON.stringify({ query, variables: options.variables ?? {}, ...(options.operationName ? { operationName: options.operationName } : {}) }),
      signal: options.signal,
    })
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errors: GraphQLErrorItem[] = Array.isArray(j?.errors) ? j.errors : []
      const msg = j?.message || errors[0]?.message || (res.status === 404 ? 'The GraphQL API is not turned on for this project (Studio › API › GraphQL)' : `Request failed (${res.status})`)
      return { data: j?.data ?? null, ...(errors.length ? { errors } : {}), error: new GraphQLError(msg, res.status, errors) }
    }
    const errors: GraphQLErrorItem[] | undefined = Array.isArray(j?.errors) && j.errors.length ? j.errors : undefined
    return { data: (j?.data ?? null) as T | null, ...(errors ? { errors } : {}), error: errors ? new GraphQLError(errors[0]?.message || 'GraphQL error', res.status, errors) : null }
  } catch (e: any) {
    return { data: null, error: new GraphQLError(e?.message || String(e), 0) }
  }
}
