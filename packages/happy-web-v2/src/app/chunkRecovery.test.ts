import { describe, expect, it, vi } from 'vitest';
import { createChunkRecovery, isChunkLoadError, installChunkRecovery } from './chunkRecovery';

describe('chunk failure recovery', () => {
  it('flushes before recovery and preserves the import rejection for the error boundary', () => {
    const target = new EventTarget(); const calls: string[] = [];
    const dispose = installChunkRecovery(target, () => { calls.push('flush'); }, async () => { calls.push('recover'); return 'reloading'; });
    const event = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(event);
    expect(calls).toEqual(['flush', 'recover']);
    expect(event.defaultPrevented).toBe(false);
    dispose(); target.dispatchEvent(new Event('vite:preloadError'));
    expect(calls).toHaveLength(2);
  });
  const memory = () => { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } }; };
  it('recognizes browser import failures without treating application bugs as updates', () => {
    for (const text of ['Failed to fetch dynamically imported module: https://x/assets/a.js', 'Importing a module script failed.', 'error loading dynamically imported module', 'Unable to preload CSS for /assets/a.css']) expect(isChunkLoadError(new TypeError(text))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
  it('coalesces concurrent failures and persists a guard across document reloads', async () => {
    const storage = memory(); const entry = vi.fn(async () => 'index-new.js'); const apply = vi.fn(async () => {});
    const recover = createChunkRecovery({ entry, apply, storage: () => storage });
    await Promise.all([recover(), recover()]);
    expect(entry).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(1);
    const nextDocument = createChunkRecovery({ entry, apply, storage: () => storage });
    expect(await nextDocument()).toBe('blocked'); expect(apply).toHaveBeenCalledTimes(1);
    expect(await nextDocument(true)).toBe('reloading'); expect(apply).toHaveBeenCalledTimes(2);
  });
  it('allows a later deployment despite an earlier attempt', async () => {
    const storage = memory(); const apply = vi.fn(async () => {});
    for (const target of ['index-a.js', 'index-b.js']) expect(await createChunkRecovery({ entry: async () => target, storage: () => storage, apply })()).toBe('reloading');
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it('does not reload while offline or when persistent guards cannot be saved', async () => {
    const apply = vi.fn(async () => {});
    expect(await createChunkRecovery({ entry: async () => null, apply, storage: memory })()).toBe('unavailable');
    const recover = createChunkRecovery({ entry: async () => 'index-new.js', apply, storage: () => { throw Error('blocked'); } });
    expect(await recover()).toBe('blocked'); expect(apply).not.toHaveBeenCalled();
    expect(await recover(true)).toBe('reloading');
  });
});
