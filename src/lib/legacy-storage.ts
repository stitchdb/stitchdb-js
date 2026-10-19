import type { SupportedStorage } from '../auth/index'
import { supportsLocalStorage } from '../auth/lib/helpers'

/**
 * Wrap the session storage so values saved under the previous key name (`sb-<ref>-auth-token`,
 * plus its `-code-verifier` / `-user` companions) are read once, moved to the new key
 * (`stitchdb-<ref>-auth-token…`) and removed. Users stay signed in across the SDK upgrade.
 * Returns the storage unchanged when there is nothing to wrap (no storage available).
 */
export function withLegacyStorageKey(
  storage: SupportedStorage | undefined,
  newKey: string,
  oldKey: string
): SupportedStorage | undefined {
  const base: SupportedStorage | undefined =
    storage ?? (supportsLocalStorage() ? (globalThis.localStorage as unknown as SupportedStorage) : undefined)
  if (!base) return storage
  const legacyKeyFor = (key: string) => (key === newKey || key.startsWith(newKey + '-') ? oldKey + key.slice(newKey.length) : null)
  const wrapped: SupportedStorage = {
    ...(base.isServer !== undefined ? { isServer: base.isServer } : {}),
    async getItem(key: string) {
      const value = await base.getItem(key)
      if (value !== null && value !== undefined) return value
      const legacy = legacyKeyFor(key)
      if (!legacy) return value
      const old = await base.getItem(legacy)
      if (old === null || old === undefined) return value
      await base.setItem(key, old)
      await base.removeItem(legacy)
      return old
    },
    setItem: (key: string, value: string) => base.setItem(key, value),
    removeItem: async (key: string) => {
      await base.removeItem(key)
      const legacy = legacyKeyFor(key)
      if (legacy) await base.removeItem(legacy)
    },
  }
  return wrapped
}
