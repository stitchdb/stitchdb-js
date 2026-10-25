import type { Fetch } from './lib/types'

export type SearchOptions = {
  /** 1 to 100 results (default 20). */
  limit?: number
  /** `hybrid` (words and meaning; the default for semantic indexes), `keyword` or `semantic`. */
  mode?: 'hybrid' | 'keyword' | 'semantic'
  /** Columns to return, e.g. `'id,title'` (default: all). */
  select?: string
}

export type SearchScore = { score: number; keyword_rank: number | null; semantic_rank: number | null }

export type SearchResponse<Row> =
  | { data: Row[]; scores: SearchScore[]; mode: 'hybrid' | 'keyword' | 'semantic'; note?: string; error: null }
  | { data: null; scores: null; mode: null; error: SearchError }

export class SearchError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SearchError'
    this.status = status
  }
}

/** Search a table that has a search index (Studio › Database › Search), with the caller's row level security. */
export async function search<Row = Record<string, unknown>>(url: string, fetch: Fetch, table: string, q: string, options: SearchOptions = {}): Promise<SearchResponse<Row>> {
  try {
    const res = await fetch(`${url}/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, ...options }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { data: null, scores: null, mode: null, error: new SearchError(json.message || json.error || `Search failed (${res.status})`, res.status) }
    return { data: json.data, scores: json.scores, mode: json.mode, ...(json.note ? { note: json.note } : {}), error: null }
  } catch (e: any) {
    return { data: null, scores: null, mode: null, error: new SearchError(e?.message || String(e), 0) }
  }
}
