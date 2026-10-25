import type { Fetch } from './lib/types'

/** A purchase to check: Apple (StoreKit 2 transaction) or Google Play (purchase token). */
export type PurchaseInput =
  | {
      store: 'apple'
      /** The transaction's `jwsRepresentation` (StoreKit 2). Checked against Apple's certificates. */
      signed_transaction?: string
      /** The transaction id; with an App Store Server API key in Studio, the status comes from Apple. */
      transaction_id?: string | number
    }
  | {
      store: 'google'
      purchase_token: string
      /** Needed for one-time products. */
      product_id?: string
      type?: 'subscription' | 'product'
      package_name?: string
    }

export type Purchase = {
  id: number
  store: 'apple' | 'google'
  product_id: string
  kind: 'subscription' | 'one_time'
  status: 'active' | 'grace' | 'billing_retry' | 'paused' | 'pending' | 'expired' | 'refunded' | 'revoked'
  environment: 'production' | 'sandbox'
  auto_renew: boolean | null
  purchased_at: string | null
  expires_at: string | null
  grace_until: string | null
  original_id: string
  updated_at: string
}

export class PurchasesError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PurchasesError'
    this.status = status
  }
}

/**
 * In-app purchases (`stitchdb.purchases`): send App Store and Google Play purchases right after buying (and on
 * restore). They are checked with the store and saved for the signed-in user; entitlements come back at once.
 */
export class PurchasesClient {
  constructor(
    private url: string,
    private fetch: Fetch
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(this.url + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new PurchasesError(json.message || `Purchases request failed (${res.status})`, res.status)
    return json as T
  }

  /** Which stores are set up for this project. */
  config(): Promise<{ apple: { bundle_id: string } | null; google: { package_name: string } | null }> {
    return this.req('GET', '/config')
  }

  /** Check a purchase with the store and link it to the signed-in user. Call after every purchase and restore. */
  sync(purchase: PurchaseInput): Promise<{ purchase: Purchase; entitlements: string[] }> {
    return this.req('POST', '/sync', purchase)
  }

  /** The signed-in user's purchases and active entitlements. */
  me(): Promise<{ purchases: Purchase[]; entitlements: string[] }> {
    return this.req('GET', '/me')
  }

  /** True when the signed-in user has this entitlement (an active or in-grace purchase of one of its products). */
  async hasEntitlement(name: string): Promise<boolean> {
    return (await this.me()).entitlements.includes(name)
  }

  /** Server side (service role key): check a user's purchases with the stores again. */
  refresh(userId: string): Promise<{ purchases: Purchase[]; entitlements: string[] }> {
    return this.req('POST', '/refresh', { user_id: userId })
  }
}
