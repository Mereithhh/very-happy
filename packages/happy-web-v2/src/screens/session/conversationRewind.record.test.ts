import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-544: when the conversation-rewind ack is lost the web waits for the
 * wrapper's `metadata.rewind` record in the store (metadata updates arrive
 * over the update stream).
 */
const store = vi.hoisted(() => {
    let state: any = { sessions: {} };
    const listeners = new Set<() => void>();
    return {
        storage: {
            getState: () => state,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        set(next: any) { state = next; for (const listener of [...listeners]) listener(); },
        listeners,
    };
});
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/sync/storage', () => ({ storage: store.storage }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
import { waitForRewindRecordInStore } from './conversationRewind';
import { MetadataSchema } from '@/sync/storageTypes';

const withRecord = (rewind: unknown) => ({ sessions: { s: { metadata: { path: '/p', host: 'h', rewind } } } });

beforeEach(() => { vi.useFakeTimers(); store.set({ sessions: {} }); });
afterEach(() => { vi.useRealTimers(); });

describe('waitForRewindRecordInStore', () => {
    it('resolves true as soon as the metadata update with this requestId lands', async () => {
        const found = waitForRewindRecordInStore('s', 'req-1', 10_000);
        store.set(withRecord({ requestId: 'other', state: 'pending' }));
        await vi.advanceTimersByTimeAsync(1_000);
        store.set(withRecord({ requestId: 'req-1', state: 'pending' }));
        expect(await found).toBe(true);
        expect(store.listeners.size).toBe(0);
    });

    it('resolves false after the window, and ignores a record the wrapper already reverted', async () => {
        const found = waitForRewindRecordInStore('s', 'req-1', 10_000);
        store.set(withRecord({ requestId: 'req-1', state: 'reverted' }));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await found).toBe(false);
        expect(store.listeners.size).toBe(0);
    });

    it('is immediate when the record is already there', async () => {
        store.set(withRecord({ requestId: 'req-1', state: 'confirmed' }));
        expect(await waitForRewindRecordInStore('s', 'req-1', 10_000)).toBe(true);
    });
});

describe('MetadataSchema keeps rewind (B-544)', () => {
    const base = { path: '/repo', host: 'h' };
    it('round-trips the wrapper record so a web metadata write cannot strip it', () => {
        const rewind = { requestId: 'r', action: 'edit', sourceClaudeSessionId: 'a', claudeSessionId: null, at: 1, state: 'pending' };
        expect(MetadataSchema.parse({ ...base, rewind }).rewind).toEqual(rewind);
    });
    it('a malformed record never fails the whole metadata parse', () => {
        const parsed = MetadataSchema.safeParse({ ...base, rewind: 'pending' });
        expect(parsed.success && parsed.data.path).toBe('/repo');
        expect(MetadataSchema.parse(base).rewind).toBeUndefined();
    });
});
