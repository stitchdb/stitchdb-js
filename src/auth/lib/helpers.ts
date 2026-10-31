import {
  API_VERSION_HEADER_NAME,
  BASE64URL_REGEX,
  PKCE_FLOW_ID_PARAM,
  PKCE_MAX_CONCURRENT_FLOWS,
} from './constants'
import { AuthInvalidJwtError } from './errors'
import { base64UrlToUint8Array, stringFromBase64URL } from './base64url'
import { JwtHeader, JwtPayload, SupportedStorage, User } from './types'
import { Uint8Array_ } from './webauthn.dom'

export function expiresAt(expiresIn: number) {
  const timeNow = Math.round(Date.now() / 1000)
  return timeNow + expiresIn
}

/**
 * Generates a unique identifier for internal callback subscriptions.
 *
 * This function uses JavaScript Symbols to create guaranteed-unique identifiers
 * for auth state change callbacks. Symbols are ideal for this use case because:
 * - They are guaranteed unique by the JavaScript runtime
 * - They work in all environments (browser, SSR, Node.js)
 * - They avoid issues with Next.js 16 deterministic rendering requirements
 * - They are perfect for internal, non-serializable identifiers
 *
 * Note: This function is only used for internal subscription management,
 * not for security-critical operations like session tokens.
 */
export function generateCallbackId(): symbol {
  return Symbol('auth-callback')
}

export const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'

/**
 * Adds the browser's language as `locale` to sign-up metadata, so the project's auth e-mails can be sent in the
 * user's language. Metadata that already has `locale`, `language` or `lang` is left as it is; outside a browser
 * nothing is added.
 */
export function withLocale(data?: object): object {
  const d: { [key: string]: any } = { ...(data || {}) }
  if (d.locale == null && d.language == null && d.lang == null && isBrowser()) {
    const l = typeof navigator !== 'undefined' ? navigator.language : undefined
    if (typeof l === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(l)) d.locale = l
  }
  return d
}

const localStorageWriteTests = {
  tested: false,
  writable: false,
}

/**
 * Checks whether localStorage is supported on this browser.
 */
export const supportsLocalStorage = () => {
  if (!isBrowser()) {
    return false
  }

  try {
    if (typeof globalThis.localStorage !== 'object') {
      return false
    }
  } catch (e) {
    // DOM exception when accessing `localStorage`
    return false
  }

  if (localStorageWriteTests.tested) {
    return localStorageWriteTests.writable
  }

  const randomKey = `lswt-${Math.random()}${Math.random()}`

  try {
    globalThis.localStorage.setItem(randomKey, randomKey)
    globalThis.localStorage.removeItem(randomKey)

    localStorageWriteTests.tested = true
    localStorageWriteTests.writable = true
  } catch (e) {
    // localStorage can't be written to
    // https://www.chromium.org/for-testers/bug-reporting-guidelines/uncaught-securityerror-failed-to-read-the-localstorage-property-from-window-access-is-denied-for-this-document

    localStorageWriteTests.tested = true
    localStorageWriteTests.writable = false
  }

  return localStorageWriteTests.writable
}

/**
 * Extracts parameters encoded in the URL both in the query and fragment.
 */
export function parseParametersFromURL(href: string) {
  const result: { [parameter: string]: string } = {}

  const url = new URL(href)

  if (url.hash && url.hash[0] === '#') {
    try {
      const hashSearchParams = new URLSearchParams(url.hash.substring(1))
      hashSearchParams.forEach((value, key) => {
        result[key] = value
      })
    } catch (_e) {
      // hash is not a query string
    }
  }

  // search parameters take precedence over hash parameters
  url.searchParams.forEach((value, key) => {
    result[key] = value
  })

  return result
}

type Fetch = typeof fetch

export const resolveFetch = (customFetch?: Fetch): Fetch => {
  if (customFetch) {
    return (...args) => customFetch(...args)
  }
  return (...args) => fetch(...args)
}

export const looksLikeFetchResponse = (maybeResponse: unknown): maybeResponse is Response => {
  return (
    typeof maybeResponse === 'object' &&
    maybeResponse !== null &&
    'status' in maybeResponse &&
    'ok' in maybeResponse &&
    'json' in maybeResponse &&
    typeof (maybeResponse as any).json === 'function'
  )
}

// Storage helpers
export const setItemAsync = async (
  storage: SupportedStorage,
  key: string,
  data: any
): Promise<void> => {
  await storage.setItem(key, JSON.stringify(data))
}

export const getItemAsync = async (storage: SupportedStorage, key: string): Promise<unknown> => {
  const value = await storage.getItem(key)

  if (!value) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    // Storage values are always written as JSON via setItemAsync. A non-JSON
    // value means the entry is corrupted (e.g. mismatched chunked cookies in
    // SSR contexts). Treat as absent so callers do not mutate or re-save the
    // garbage, which would otherwise trigger a TypeError downstream and
    // leak the raw value into error logs.
    return null
  }
}

export const removeItemAsync = async (storage: SupportedStorage, key: string): Promise<void> => {
  await storage.removeItem(key)
}

/**
 * A deferred represents some asynchronous work that is not yet finished, which
 * may or may not culminate in a value.
 * Taken from: https://github.com/mike-north/types/blob/master/src/async.ts
 */
export class Deferred<T = any> {
  public static promiseConstructor: PromiseConstructor = Promise

  public readonly promise!: PromiseLike<T>

  public readonly resolve!: (value?: T | PromiseLike<T>) => void

  public readonly reject!: (reason?: any) => any

  public constructor() {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;(this as any).promise = new Deferred.promiseConstructor((res, rej) => {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;(this as any).resolve = res
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;(this as any).reject = rej
    })
  }
}

export function decodeJWT(token: string): {
  header: JwtHeader
  payload: JwtPayload
  signature: Uint8Array_
  raw: {
    header: string
    payload: string
  }
} {
  const parts = token.split('.')

  if (parts.length !== 3) {
    throw new AuthInvalidJwtError('Invalid JWT structure')
  }

  // Regex checks for base64url format
  for (let i = 0; i < parts.length; i++) {
    if (!BASE64URL_REGEX.test(parts[i] as string)) {
      throw new AuthInvalidJwtError('JWT not in base64url format')
    }
  }
  const data = {
    // using base64url lib
    header: JSON.parse(stringFromBase64URL(parts[0])),
    payload: JSON.parse(stringFromBase64URL(parts[1])),
    signature: base64UrlToUint8Array(parts[2]),
    raw: {
      header: parts[0],
      payload: parts[1],
    },
  }
  return data
}

/**
 * Creates a promise that resolves to null after some time.
 */
export async function sleep(time: number): Promise<null> {
  return await new Promise((accept) => {
    setTimeout(() => accept(null), time)
  })
}

/**
 * Converts the provided async function into a retryable function. Each result
 * or thrown error is sent to the isRetryable function which should return true
 * if the function should run again.
 */
export function retryable<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryable: (attempt: number, error: any | null, result?: T) => boolean
): Promise<T> {
  const promise = new Promise<T>((accept, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;(async () => {
      for (let attempt = 0; attempt < Infinity; attempt++) {
        try {
          const result = await fn(attempt)

          if (!isRetryable(attempt, null, result)) {
            accept(result)
            return
          }
        } catch (e) {
          if (!isRetryable(attempt, e)) {
            reject(e)
            return
          }
        }
      }
    })()
  })

  return promise
}

function dec2hex(dec: number) {
  return ('0' + dec.toString(16)).substr(-2)
}

// Functions below taken from: https://stackoverflow.com/questions/63309409/creating-a-code-verifier-and-challenge-for-pkce-auth-on-spotify-api-in-reactjs
export function generatePKCEVerifier() {
  const verifierLength = 56
  const array = new Uint32Array(verifierLength)
  if (typeof crypto === 'undefined') {
    const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
    const charSetLen = charSet.length
    let verifier = ''
    for (let i = 0; i < verifierLength; i++) {
      verifier += charSet.charAt(Math.floor(Math.random() * charSetLen))
    }
    return verifier
  }
  crypto.getRandomValues(array)
  return Array.from(array, dec2hex).join('')
}

async function sha256(randomString: string) {
  const encoder = new TextEncoder()
  const encodedData = encoder.encode(randomString)
  const hash = await crypto.subtle.digest('SHA-256', encodedData)
  const bytes = new Uint8Array(hash)

  return Array.from(bytes)
    .map((c) => String.fromCharCode(c))
    .join('')
}

export async function generatePKCEChallenge(verifier: string) {
  const hasCryptoSupport =
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof TextEncoder !== 'undefined'

  if (!hasCryptoSupport) {
    console.warn(
      'WebCrypto API is not supported. Code challenge method will default to use plain instead of sha256.'
    )
    return verifier
  }
  const hashed = await sha256(verifier)
  return btoa(hashed).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const PKCE_FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/

/**
 * Returns the flow id if it is a plausible flow id, `null` otherwise. Flow
 * ids can arrive via URL parameters, so anything outside the expected shape
 * is discarded before it is used to build a storage key.
 */
export function validatePKCEFlowId(flowId: unknown): string | null {
  return typeof flowId === 'string' && PKCE_FLOW_ID_PATTERN.test(flowId) ? flowId : null
}

export function generatePKCEFlowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, dec2hex).join('')
  }
  let flowId = ''
  for (let i = 0; i < 32; i++) {
    flowId += Math.floor(Math.random() * 16).toString(16)
  }
  return flowId
}

// Slot keys deliberately end in `-code-verifier`: stitchdb-js's server
// cookie adapter only persists writes immediately for keys with that suffix
// (no auth event fires when a verifier is stored). They also contain no dot,
// because stitchdb-js chunks oversized cookies as `<key>.<number>` and a
// dot-delimited key could be mistaken for a chunk of the fixed
// `-code-verifier` cookie and clobbered by its chunk management.
export const pkceVerifierSlotKey = (storageKey: string, flowId: string) =>
  `${storageKey}-flow-${flowId}-code-verifier`

const pkceFlowIndexKey = (storageKey: string) => `${storageKey}-flows-code-verifier`

/**
 * Storage adapters cannot enumerate keys, so the ids of pending verifier
 * slots are tracked in an index entry, oldest first. Index entries pass
 * through the same validation as URL-provided flow ids: with cookie-based
 * storage the index contents are no more trustworthy than a URL parameter.
 */
async function getPKCEFlowIndex(storage: SupportedStorage, storageKey: string): Promise<string[]> {
  const index = await getItemAsync(storage, pkceFlowIndexKey(storageKey))
  return Array.isArray(index)
    ? index.filter((id): id is string => validatePKCEFlowId(id) !== null)
    : []
}

/**
 * The index is read-modify-write without a lock: two concurrent starts (e.g.
 * two tabs) can lose one index update. The losing flow still works — its slot
 * is addressed directly by key — but its entry is missing from the index, so
 * it escapes both ring eviction and removeAllPKCEVerifiers: the orphaned slot
 * persists for the storage medium's lifetime (up to the cookie max age in
 * cookie storage) and repeated races accumulate one orphan each. Accepted
 * trade-off: locking every flow start is far more intrusive than the leak.
 */
export async function storePKCEVerifier(
  storage: SupportedStorage,
  storageKey: string,
  flowId: string,
  verifier: string,
  onEvictFlow?: (evictedFlowId: string) => void
): Promise<void> {
  await setItemAsync(storage, pkceVerifierSlotKey(storageKey, flowId), verifier)

  const index = (await getPKCEFlowIndex(storage, storageKey)).filter((id) => id !== flowId)
  index.push(flowId)
  while (index.length > PKCE_MAX_CONCURRENT_FLOWS) {
    const evicted = index.shift()!
    await removeItemAsync(storage, pkceVerifierSlotKey(storageKey, evicted))
    onEvictFlow?.(evicted)
  }
  await setItemAsync(storage, pkceFlowIndexKey(storageKey), index)

  // Deprecation-window dual write: exchanges that cannot identify their flow
  // (older SDK versions, redirects without the flow id parameter) read the
  // fixed key, which mirrors the most recently started flow.
  await setItemAsync(storage, `${storageKey}-code-verifier`, verifier)
}

/**
 * Looks up the verifier for `flowId`. When a flow id is given, only that slot
 * is consulted — deliberately no fallback to the fixed legacy key: submitting
 * another flow's verifier would burn the single-use auth code, and the
 * subsequent cleanup would delete a pending flow's only fallback. The legacy
 * key is read only when no flow id is available at all.
 */
export async function retrievePKCEVerifier(
  storage: SupportedStorage,
  storageKey: string,
  flowId: string | null
): Promise<{ verifier: string | null; flowId: string | null }> {
  if (flowId) {
    const verifier = await getItemAsync(storage, pkceVerifierSlotKey(storageKey, flowId))
    return { verifier: typeof verifier === 'string' ? verifier : null, flowId }
  }
  const verifier = await getItemAsync(storage, `${storageKey}-code-verifier`)
  return { verifier: typeof verifier === 'string' ? verifier : null, flowId: null }
}

/**
 * Removes a single flow's verifier. Never clears other flows' slots: with a
 * `flowId` only that slot is deleted (plus the legacy fixed key when it holds
 * the same verifier); without one, only the legacy fixed key is deleted.
 */
export async function removePKCEVerifier(
  storage: SupportedStorage,
  storageKey: string,
  flowId: string | null
): Promise<void> {
  const legacyKey = `${storageKey}-code-verifier`
  if (!flowId) {
    await removeItemAsync(storage, legacyKey)
    return
  }

  const slotKey = pkceVerifierSlotKey(storageKey, flowId)
  const slotValue = await getItemAsync(storage, slotKey)
  await removeItemAsync(storage, slotKey)

  // Skip the index rewrite when the flow was never indexed (e.g. a failed
  // exchange for an absent slot): on cookie storage every write is a full
  // Set-Cookie cycle.
  const index = await getPKCEFlowIndex(storage, storageKey)
  const remaining = index.filter((id) => id !== flowId)
  if (remaining.length !== index.length) {
    if (remaining.length > 0) {
      await setItemAsync(storage, pkceFlowIndexKey(storageKey), remaining)
    } else {
      await removeItemAsync(storage, pkceFlowIndexKey(storageKey))
    }
  }

  if (slotValue != null && slotValue === (await getItemAsync(storage, legacyKey))) {
    await removeItemAsync(storage, legacyKey)
  }
}

/**
 * Removes every pending verifier: all slots in the index, the index itself
 * and the fixed legacy key. Used on session teardown (sign-out, invalid
 * session) — matches the pre-slot behavior where tearing down the session
 * deleted the only verifier, and prevents long-lived stale verifier cookies.
 */
export async function removeAllPKCEVerifiers(
  storage: SupportedStorage,
  storageKey: string
): Promise<void> {
  const index = await getPKCEFlowIndex(storage, storageKey)
  for (const flowId of index) {
    await removeItemAsync(storage, pkceVerifierSlotKey(storageKey, flowId))
  }
  await removeItemAsync(storage, pkceFlowIndexKey(storageKey))
  await removeItemAsync(storage, `${storageKey}-code-verifier`)
}

/**
 * Appends the reserved flow id parameter to a `redirectTo` URL, replacing any
 * existing occurrence. String-based (no URL round-trip) so custom schemes
 * (native deep links) and the exact encoding of the app's own parameters
 * survive untouched; an existing fragment stays at the end of the URL.
 */
export function appendFlowIdToRedirectTo(redirectTo: string, flowId: string): string {
  const hashIndex = redirectTo.indexOf('#')
  let base = hashIndex === -1 ? redirectTo : redirectTo.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : redirectTo.slice(hashIndex)

  const queryIndex = base.indexOf('?')
  if (queryIndex !== -1) {
    const path = base.slice(0, queryIndex)
    const remaining = base
      .slice(queryIndex + 1)
      .split('&')
      .filter(
        (pair) =>
          pair !== '' && pair !== PKCE_FLOW_ID_PARAM && !pair.startsWith(`${PKCE_FLOW_ID_PARAM}=`)
      )
    base = remaining.length > 0 ? `${path}?${remaining.join('&')}` : path
  }

  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}${PKCE_FLOW_ID_PARAM}=${encodeURIComponent(flowId)}${fragment}`
}

export async function getCodeChallengeAndMethod(
  storage: SupportedStorage,
  storageKey: string,
  isPasswordRecovery = false,
  onEvictFlow?: (evictedFlowId: string) => void
): Promise<[string, string, string]> {
  const codeVerifier = generatePKCEVerifier()
  let storedCodeVerifier = codeVerifier
  if (isPasswordRecovery) {
    storedCodeVerifier += '/recovery'
  }
  const flowId = generatePKCEFlowId()
  await storePKCEVerifier(storage, storageKey, flowId, storedCodeVerifier, onEvictFlow)
  const codeChallenge = await generatePKCEChallenge(codeVerifier)
  const codeChallengeMethod = codeVerifier === codeChallenge ? 'plain' : 's256'
  return [codeChallenge, codeChallengeMethod, flowId]
}

/** Parses the API version which is 2YYY-MM-DD. */
const API_VERSION_REGEX = /^2[0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-9]|3[0-1])$/i

export function parseResponseAPIVersion(response: Response) {
  const apiVersion = response.headers.get(API_VERSION_HEADER_NAME)

  if (!apiVersion) {
    return null
  }

  if (!apiVersion.match(API_VERSION_REGEX)) {
    return null
  }

  try {
    const date = new Date(`${apiVersion}T00:00:00.0Z`)
    return date
  } catch (_e) {
    return null
  }
}

export function validateExp(exp: number) {
  if (!exp) {
    throw new Error('Missing exp claim')
  }
  const timeNow = Math.floor(Date.now() / 1000)
  if (exp <= timeNow) {
    throw new Error('JWT has expired')
  }
}

export function getAlgorithm(
  alg: 'HS256' | 'RS256' | 'ES256' | (string & {})
): RsaHashedImportParams | EcKeyImportParams {
  switch (alg) {
    case 'RS256':
      return {
        name: 'RSASSA-PKCS1-v1_5',
        hash: { name: 'SHA-256' },
      }
    case 'ES256':
      return {
        name: 'ECDSA',
        namedCurve: 'P-256',
        hash: { name: 'SHA-256' },
      }
    default:
      throw new Error('Invalid alg claim')
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUUID(str: string) {
  if (!UUID_REGEX.test(str)) {
    throw new Error('stitchdb-js: Expected parameter to be UUID but is not')
  }
}

export function assertRecoveryCodesExperimentalEnabled(experimental: {
  recoveryCodes?: boolean
}): void {
  if (!experimental.recoveryCodes) {
    throw new Error(
      'stitchdb-js: the MFA recovery codes API is experimental and disabled by default. Enable it by passing `auth: { experimental: { recoveryCodes: true } }` to createClient (or to the GoTrueClient constructor).'
    )
  }
}

export function userNotAvailableProxy(): User {
  const proxyTarget = {} as User

  return new Proxy(proxyTarget, {
    get: (target: any, prop: string) => {
      if (prop === '__isUserNotAvailableProxy') {
        return true
      }
      // Preventative check for common problematic symbols during cloning/inspection
      // These symbols might be accessed by structuredClone or other internal mechanisms.
      if (typeof prop === 'symbol') {
        const sProp = (prop as symbol).toString()
        if (
          sProp === 'Symbol(Symbol.toPrimitive)' ||
          sProp === 'Symbol(Symbol.toStringTag)' ||
          sProp === 'Symbol(util.inspect.custom)'
        ) {
          // Node.js util.inspect
          return undefined
        }
      }
      throw new Error(
        `stitchdb-js: client was created with userStorage option and there was no user stored in the user storage. Accessing the "${prop}" property of the session object is not supported. Please use getUser() instead.`
      )
    },
    set: (_target: any, prop: string) => {
      throw new Error(
        `stitchdb-js: client was created with userStorage option and there was no user stored in the user storage. Setting the "${prop}" property of the session object is not supported. Please use getUser() to fetch a user object you can manipulate.`
      )
    },
    deleteProperty: (_target: any, prop: string) => {
      throw new Error(
        `stitchdb-js: client was created with userStorage option and there was no user stored in the user storage. Deleting the "${prop}" property of the session object is not supported. Please use getUser() to fetch a user object you can manipulate.`
      )
    },
  })
}

/**
 * Creates a proxy around a user object that warns when properties are accessed on the server.
 * This is used to alert developers that using user data from getSession() on the server is insecure.
 *
 * @param user The actual user object to wrap
 * @param suppressWarningRef An object with a 'value' property that controls warning suppression
 * @returns A proxied user object that warns on property access
 */
export function insecureUserWarningProxy(user: User, suppressWarningRef: { value: boolean }): User {
  return new Proxy(user, {
    get: (target: any, prop: string | symbol, receiver: any) => {
      // Allow internal checks without warning
      if (prop === '__isInsecureUserWarningProxy') {
        return true
      }

      // Preventative check for common problematic symbols during cloning/inspection
      // These symbols might be accessed by structuredClone or other internal mechanisms
      if (typeof prop === 'symbol') {
        const sProp = prop.toString()
        if (
          sProp === 'Symbol(Symbol.toPrimitive)' ||
          sProp === 'Symbol(Symbol.toStringTag)' ||
          sProp === 'Symbol(util.inspect.custom)' ||
          sProp === 'Symbol(nodejs.util.inspect.custom)'
        ) {
          // Return the actual value for these symbols to allow proper inspection
          return Reflect.get(target, prop, receiver)
        }
      }

      // Emit warning on first property access
      if (!suppressWarningRef.value && typeof prop === 'string') {
        console.warn(
          'Using the user object as returned from stitchdb.auth.getSession() or from some stitchdb.auth.onAuthStateChange() events could be insecure! This value comes directly from the storage medium (usually cookies on the server) and may not be authentic. Use stitchdb.auth.getUser() instead which authenticates the data by contacting the StitchDB Auth server.'
        )
        suppressWarningRef.value = true
      }

      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Deep clones a JSON-serializable object using JSON.parse(JSON.stringify(obj)).
 * Note: Only works for JSON-safe data.
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/**
 * Solves the project's built-in sign-up check (SHA-256 proof of work): finds `number` so that
 * SHA-256(salt + number) is the challenge, and returns the answer to send as `stitchdb_captcha`.
 *
 * A plain SHA-256 on one reused buffer, comparing words instead of hex: `crypto.subtle.digest` awaited once per
 * number took ~65 µs a hash, so a phone at the top difficulty (1,000,000) needed over a minute; this is ~1 µs.
 * It yields every 20,000 numbers so the page stays responsive.
 */
export async function solveSignupCheck(ch: {
  algorithm?: string
  challenge?: string
  salt?: string
  maxnumber?: number
  signature?: string
}): Promise<string | null> {
  if (!ch || typeof ch.salt !== 'string' || typeof ch.challenge !== 'string') return null
  const want = ch.challenge.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(want)) return null
  const max = Math.min(Number(ch.maxnumber) || 0, 1000000)
  const T = new Uint32Array(8)
  for (let i = 0; i < 8; i++) T[i] = parseInt(want.slice(i * 8, i * 8 + 8), 16) >>> 0
  const salt = new TextEncoder().encode(ch.salt)
  const m = new Uint8Array(((salt.length + 8 + 9 + 63) >> 6) << 6)
  const w = new Uint32Array(64)
  const H = new Uint32Array(8)
  const K = SHA256_K
  m.set(salt)
  for (let n = 0; n <= max; n++) {
    if (n && n % 20000 === 0) await new Promise((r) => setTimeout(r, 0))
    const digits = String(n)
    let l = salt.length
    for (let i = 0; i < digits.length; i++) m[l++] = digits.charCodeAt(i)
    const nb = ((l + 9 + 63) >> 6) << 6
    m.fill(0, l, nb)
    m[l] = 0x80
    const bits = l * 8
    m[nb - 4] = bits >>> 24
    m[nb - 3] = bits >>> 16
    m[nb - 2] = bits >>> 8
    m[nb - 1] = bits
    H[0] = 0x6a09e667; H[1] = 0xbb67ae85; H[2] = 0x3c6ef372; H[3] = 0xa54ff53a
    H[4] = 0x510e527f; H[5] = 0x9b05688c; H[6] = 0x1f83d9ab; H[7] = 0x5be0cd19
    for (let o = 0; o < nb; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3]
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15], y = w[i - 2]
        w[i] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + w[i - 16]
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
        const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
    }
    if (H[0] === T[0] && H[1] === T[1] && H[2] === T[2] && H[3] === T[3] && H[4] === T[4] && H[5] === T[5] && H[6] === T[6] && H[7] === T[7]) {
      const answer = JSON.stringify({ ...ch, number: n })
      return typeof btoa === 'function' ? btoa(answer) : Buffer.from(answer).toString('base64')
    }
  }
  return null
}
