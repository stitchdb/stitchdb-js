import StorageFileApi from './packages/StorageFileApi'
import StorageBucketApi from './packages/StorageBucketApi'
import StorageAnalyticsClient from './packages/StorageAnalyticsClient'
import { Fetch } from './lib/common/fetch'
import { StorageVectorsClient } from './packages/StorageVectorsClient'

export interface StorageClientOptions {
  useNewHostname?: boolean
}

export class StorageClient extends StorageBucketApi {
  /**
   * Creates a client for Storage buckets and files.
   *
   * @category Storage
   * @subcategory File Buckets
   *
   * @example Using stitchdb-js (recommended)
   * ```ts
   * import { createClient } from 'stitchdb-js'
   *
   * const stitchdb = createClient('https://xyzcompany.stitchdb.com', 'your-anon-key')
   * const avatars = stitchdb.storage.from('avatars')
   * ```
   *
   * @example Standalone import for bundle-sensitive environments
   * ```ts
   * import { StorageClient } from 'stitchdb-js'
   *
   * const storage = new StorageClient('https://xyzcompany.stitchdb.com/storage/v1', {
   *   apikey: 'your-anon-key',
   * })
   * const avatars = storage.from('avatars')
   * ```
   */
  constructor(
    url: string,
    headers: { [key: string]: string } = {},
    fetch?: Fetch,
    opts?: StorageClientOptions
  ) {
    super(url, headers, fetch, opts)
  }

  /**
   * Perform file operation in a bucket.
   *
   * @category Storage
   * @subcategory File Buckets
   *
   * @param id The bucket id to operate on.
   *
   * @example Accessing a bucket
   * ```typescript
   * const avatars = stitchdb.storage.from('avatars')
   * ```
   */
  from(id: string): StorageFileApi {
    return new StorageFileApi(this.url, this.headers, id, this.fetch)
  }

  /**
   *
   * @alpha
   *
   * Access vector storage operations.
   *
   * **Not available on StitchDB:** analytics (Iceberg) buckets are not offered; these calls return an error.
   *
   * @category Storage
   * @subcategory Vector Buckets
   *
   * @returns A StorageVectorsClient instance configured with the current storage settings.
   */
  get vectors(): StorageVectorsClient {
    return new StorageVectorsClient(this.url + '/vector', {
      headers: this.headers,
      fetch: this.fetch,
    })
  }

  /**
   *
   * @alpha
   *
   * Access analytics storage operations using Iceberg tables.
   *
   * **Not available on StitchDB:** analytics (Iceberg) buckets are not offered; these calls return an error.
   *
   * @category Storage
   * @subcategory Analytics Buckets
   *
   * @returns A StorageAnalyticsClient instance configured with the current storage settings.
   */
  get analytics(): StorageAnalyticsClient {
    return new StorageAnalyticsClient(this.url + '/iceberg', this.headers, this.fetch)
  }
}
