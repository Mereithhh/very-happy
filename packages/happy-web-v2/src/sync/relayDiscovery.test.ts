import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { discoverRelay, RELAY_DISCOVERY_TIMEOUT_MS } from './relayDiscovery';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['success', 'http-error', 'json-error'])('clears the deadline on %s', async (outcome) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: outcome !== 'http-error', status: 503,
        json: async () => {
            if (outcome === 'json-error') throw new Error('bad json');
            return { assignment: null };
        },
    })));
    const result = discoverRelay('https://control.test/discovery', {});
    if (outcome === 'success') await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RELAY_DISCOVERY_TIMEOUT_MS);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false);
});

it('clears its deadline and aborts a body that never finishes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })));
    const result = expect(discoverRelay('https://control.test/discovery', {})).rejects.toThrow('relay discovery timeout');
    await vi.advanceTimersByTimeAsync(RELAY_DISCOVERY_TIMEOUT_MS);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
