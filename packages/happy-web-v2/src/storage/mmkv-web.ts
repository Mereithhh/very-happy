/**
 * Synchronous, localStorage-backed drop-in for `react-native-mmkv`'s MMKV class.
 *
 * MMKV's API is synchronous and string-keyed, and so is localStorage — so this is
 * a faithful swap for the small config/settings blobs the data layer keeps in MMKV
 * (settings, pending-settings, local-settings, drafts, server config, push tokens,
 * notification prefs). Session/message data does NOT go through MMKV — it lives in
 * the in-memory zustand store + server sync — so localStorage's size limits are fine.
 *
 * Namespacing: `new MMKV({ id })` prefixes every key with `mmkv:<id>:` so multiple
 * instances don't collide (matches MMKV's per-instance isolation).
 */
export interface MMKVConfiguration {
  id?: string;
  path?: string;
  encryptionKey?: string;
}

const GLOBAL_PREFIX = 'mmkv';

export class MMKV {
  private prefix: string;

  constructor(config?: MMKVConfiguration) {
    const id = config?.id ?? 'default';
    this.prefix = `${GLOBAL_PREFIX}:${id}:`;
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  set(key: string, value: string | number | boolean): void {
    try {
      localStorage.setItem(this.k(key), String(value));
    } catch (e) {
      console.warn('[mmkv-web] set failed', key, e);
    }
  }

  getString(key: string): string | undefined {
    const v = localStorage.getItem(this.k(key));
    return v === null ? undefined : v;
  }

  getNumber(key: string): number | undefined {
    const v = localStorage.getItem(this.k(key));
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }

  getBoolean(key: string): boolean | undefined {
    const v = localStorage.getItem(this.k(key));
    if (v === null) return undefined;
    return v === 'true';
  }

  contains(key: string): boolean {
    return localStorage.getItem(this.k(key)) !== null;
  }

  delete(key: string): void {
    localStorage.removeItem(this.k(key));
  }

  getAllKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        keys.push(k.slice(this.prefix.length));
      }
    }
    return keys;
  }

  clearAll(): void {
    for (const k of this.getAllKeys()) {
      this.delete(k);
    }
  }

  recrypt(_key: string | undefined): void {
    // no-op: web shim does not encrypt at rest
  }
}
