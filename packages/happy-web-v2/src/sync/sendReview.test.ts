/**
 * B-513 review regressions that live in storage / InvalidateSync / sync.ts wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { InvalidateSync } from '@/utils/sync';
import type { NormalizedMessage } from './typesRaw';

let storage: typeof import('./storage').storage;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('./storage'));
});

function optimistic(localId: string): NormalizedMessage {
    return { id: localId, localId, createdAt: 1000, role: 'user', content: { type: 'text', text: 'hi' }, isSidechain: false };
}

describe('optimistic apply keeps the session loading state (review #3)', () => {
    it('does not flip a session whose history has not loaded to isLoaded', () => {
        storage.getState().applyMessages('fresh', [optimistic('l1')], { sendingLocalIds: ['l1'] });
        const entry = storage.getState().sessionMessages.fresh;
        expect(entry.isLoaded).toBe(false);
        expect(entry.messages.map((m) => m.kind)).toEqual(['user-text']);
        storage.getState().applyMessagesLoaded('fresh');
        expect(storage.getState().sessionMessages.fresh.isLoaded).toBe(true);
        expect(storage.getState().sessionMessages.fresh.messages).toHaveLength(1);
    });

    it('keeps a loaded session loaded, and a history apply still marks loaded', () => {
        storage.getState().applyMessages('loaded', [{ ...optimistic('h1'), seq: 1 }]);
        expect(storage.getState().sessionMessages.loaded.isLoaded).toBe(true);
        storage.getState().applyMessages('loaded', [optimistic('l2')], { sendingLocalIds: ['l2'] });
        expect(storage.getState().sessionMessages.loaded.isLoaded).toBe(true);
    });
});

describe('InvalidateSync.invalidateNow (review #4)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('cuts a pending backoff sleep short so new work goes out now', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let fail = true;
        const command = vi.fn(async () => {
            if (fail) throw new Error('transient');
        });
        const sync = new InvalidateSync(command);
        sync.invalidate();
        // Several failures grow the backoff sleep to seconds.
        for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(2_000);
        const callsBefore = command.mock.calls.length;
        fail = false;
        sync.invalidateNow();
        await vi.advanceTimersByTimeAsync(0);
        // Ran immediately (plus the queued re-run for the invalidation itself).
        expect(command.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('plain invalidate() still waits out the backoff (B-490 storm guard)', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const command = vi.fn(async () => { throw new Error('transient'); });
        const sync = new InvalidateSync(command);
        sync.invalidate();
        for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(2_000);
        const callsBefore = command.mock.calls.length;
        sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(command.mock.calls.length).toBe(callsBefore);
    });
});

describe('sync.ts send wiring (review #1 #2 #4 #5)', () => {
    const source = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');
    const sendMessage = source.slice(source.indexOf('    async sendMessage('), source.indexOf('    /** Persist an invisible queue-cancel tombstone'));
    const flush = source.slice(source.indexOf('    private flushOutbox = async'), source.indexOf('    private fetchMessages = async'));

    it('a whole user turn enters the outbox in one synchronous push, after every item is tracked', () => {
        expect(sendMessage.match(/pending\.push\(/g)).toEqual(['pending.push(']);
        const push = sendMessage.indexOf('pending.push(...turnItems)');
        expect(push).toBeGreaterThan(sendMessage.lastIndexOf('this.trackOutboxItems(sessionId, [localId], [encryptedRawRecord], group)'));
        expect(push).toBeGreaterThan(sendMessage.lastIndexOf('await '));
        // Each file item is tracked before it is shown.
        expect(sendMessage.indexOf('this.trackOutboxItems(sessionId, [fileLocalId], [encryptedFileRecord], group)'))
            .toBeLessThan(sendMessage.indexOf('this.applyOptimistic(sessionId, fileNormalized)'));
        expect(sendMessage).toContain('this.getSendSync(sessionId).invalidateNow()');
    });

    it('judges a failed HTTP send by the online state at dispatch', () => {
        // Re-snapshotted after the relay attempt, right before the HTTP request leaves.
        const dispatch = flush.lastIndexOf('beginSendAttempt(isBrowserOnline)');
        expect(dispatch).toBeGreaterThan(flush.indexOf('deliverSessionMessages('));
        expect(dispatch).toBeLessThan(flush.indexOf('await apiSocket.request('));
        expect(flush).toContain('const outcome = attempt.classify(error);');
        expect(flush).not.toContain('classifySendError(error, isBrowserOnline())');
    });

    it('advances lastSeq only over what interpretSendResponse says was applied', () => {
        expect(flush).toContain('this.advanceSessionLastSeq(sessionId, outcome.lastSeqCandidates)');
        expect(flush).not.toMatch(/advanceSessionLastSeq\(sessionId, stored/);
    });

    it('retry wakes the send loop instead of waiting out an old backoff', () => {
        const retry = source.slice(source.indexOf('    retrySend(sessionId: string'), source.indexOf('    takeBackFailedMessage('));
        expect(retry).toContain('this.getSendSync(sessionId).invalidateNow()');
    });

    it('every reducer apply prunes confirmed retry records', () => {
        const apply = source.slice(source.indexOf('    private applyMessages = '), source.indexOf('    private applySessions = '));
        expect(apply).toContain('if (this.outboxRecords.size > 0) this.pruneOutboxRecords(sessionId);');
    });
});
