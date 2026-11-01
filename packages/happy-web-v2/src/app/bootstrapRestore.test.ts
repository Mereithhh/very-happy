import { describe, expect, it, vi } from 'vitest';
import { restoreWithRetry } from './bootstrapRestore';
import { SyncNotStartedError } from '@/sync/syncNotStarted';

const noSleep = () => Promise.resolve();

describe('restoreWithRetry (B-859)', () => {
    it('retries a restore that failed before sync started, then succeeds', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(new SyncNotStartedError(new TypeError('ne.crypto_box_seed_keypair is not a function')))
            .mockResolvedValueOnce(undefined);
        const sleeps: number[] = [];
        await restoreWithRetry(run, { delaysMs: [300, 1000], sleep: async (ms) => { sleeps.push(ms); } });
        expect(run).toHaveBeenCalledTimes(2);
        expect(sleeps).toEqual([300]);
    });

    it('rethrows after the last attempt so bootstrap falls back to signed-out', async () => {
        const err = new SyncNotStartedError(new Error('still broken'));
        const run = vi.fn().mockRejectedValue(err);
        await expect(restoreWithRetry(run, { delaysMs: [1, 2], sleep: noSleep })).rejects.toBe(err);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it('does not retry errors raised after sync started', async () => {
        const err = new Error('server said no');
        const run = vi.fn().mockRejectedValue(err);
        await expect(restoreWithRetry(run, { delaysMs: [1, 2], sleep: noSleep })).rejects.toBe(err);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('stops retrying once the bootstrap effect is cancelled', async () => {
        let cancelled = false;
        const run = vi.fn().mockRejectedValue(new SyncNotStartedError('x'));
        await expect(restoreWithRetry(run, {
            delaysMs: [1, 2],
            sleep: async () => { cancelled = true; },
            isCancelled: () => cancelled,
        })).rejects.toBeInstanceOf(SyncNotStartedError);
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe('syncInit makes a pre-start failure retryable (B-859)', () => {
    it('clears the init flag and throws SyncNotStartedError when Encryption.create fails', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../sync/sync.ts', import.meta.url), 'utf8');
        const body = src.slice(src.indexOf('async function syncInit('));
        // Without the reset, the retried syncRestore() hits "already initialized",
        // returns quietly, and the app renders signed-in with no sync engine.
        expect(body).toMatch(/encryption = await Encryption\.create\(secretKey\);\s*\} catch \(e\) \{[^}]*isInitialized = false;\s*throw new SyncNotStartedError\(e\);/);
    });
});
