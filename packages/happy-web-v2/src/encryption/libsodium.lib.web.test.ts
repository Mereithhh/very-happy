import { afterEach, describe, expect, it, vi } from 'vitest';

// B-859b: the web sodiumReady is bounded — a wasm that never instantiates must
// reject (→ SyncNotStartedError → retry → /login), not hang the splash.
vi.mock('libsodium-wrappers', () => ({ default: { ready: new Promise<void>(() => {}) } }));

describe('web sodiumReady (B-859b)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('rejects with ReadyTimeoutError once SODIUM_READY_TIMEOUT_MS passes without wasm', async () => {
        vi.useFakeTimers();
        const { sodiumReady, SODIUM_READY_TIMEOUT_MS } = await import('./libsodium.lib.web');
        const { ReadyTimeoutError } = await import('./readyDeadline');
        expect(SODIUM_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
        expect(SODIUM_READY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
        const result = sodiumReady().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(SODIUM_READY_TIMEOUT_MS);
        expect(await result).toBeInstanceOf(ReadyTimeoutError);
    });
});
