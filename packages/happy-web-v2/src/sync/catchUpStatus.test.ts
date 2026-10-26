import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATCH_UP_SHOW_MS, CATCH_UP_SLOW_MS, catchUpStore, forgetCatchUp, trackCatchUp } from './catchUpStatus';
import { networkStore } from './networkStatus';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}

const phase = (sessionId: string) => catchUpStore.getState().sessions[sessionId] ?? null;

describe('B-804 messages catch-up status', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        networkStore.setState({ phase: 'online', syncing: [] });
    });
    afterEach(() => {
        forgetCatchUp('s1');
        forgetCatchUp('s2');
        vi.useRealTimers();
    });

    it('a catch-up that lands within 300ms shows nothing (no flicker)', async () => {
        const run = deferred();
        trackCatchUp('s1', run.promise);
        vi.advanceTimersByTime(CATCH_UP_SHOW_MS - 1);
        run.resolve();
        await vi.advanceTimersByTimeAsync(0);
        vi.advanceTimersByTime(CATCH_UP_SLOW_MS);
        expect(phase('s1')).toBeNull();
        expect(networkStore.getState().syncing).toEqual([]);
    });

    it('a slower one shows 「同步中」 (chat line + the top bar holder) and clears when it lands', async () => {
        const run = deferred();
        trackCatchUp('s1', run.promise);
        vi.advanceTimersByTime(CATCH_UP_SHOW_MS);
        expect(phase('s1')).toBe('syncing');
        expect(networkStore.getState().syncing).toEqual(['messages:s1']);
        run.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(phase('s1')).toBeNull();
        expect(networkStore.getState().syncing).toEqual([]);
    });

    it('past the request deadline it turns into 「连接不稳定」; a retry goes back to 「同步中」 with a full deadline', async () => {
        const stuck = deferred();
        trackCatchUp('s1', stuck.promise);
        vi.advanceTimersByTime(CATCH_UP_SLOW_MS - 1);
        expect(phase('s1')).toBe('syncing');
        vi.advanceTimersByTime(1);
        expect(phase('s1')).toBe('slow');
        const retry = deferred();
        trackCatchUp('s1', retry.promise);
        expect(phase('s1')).toBe('syncing');
        vi.advanceTimersByTime(CATCH_UP_SLOW_MS - 1);
        expect(phase('s1')).toBe('syncing');
        // The old round settling does not end the newer one.
        stuck.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(phase('s1')).toBe('syncing');
        retry.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(phase('s1')).toBeNull();
        expect(networkStore.getState().syncing).toEqual([]);
    });

    it('a failed catch-up also releases the bar; sessions are tracked apart', async () => {
        const a = deferred();
        const b = deferred();
        trackCatchUp('s1', a.promise);
        trackCatchUp('s2', b.promise);
        vi.advanceTimersByTime(CATCH_UP_SHOW_MS);
        expect(networkStore.getState().syncing).toEqual(['messages:s1', 'messages:s2']);
        a.reject(new Error('gave up'));
        await vi.advanceTimersByTimeAsync(0);
        expect(phase('s1')).toBeNull();
        expect(phase('s2')).toBe('syncing');
        expect(networkStore.getState().syncing).toEqual(['messages:s2']);
    });
});

describe('B-804 wiring in sync.ts', () => {
    const sync = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');
    const body = (start: string, end: string) => sync.slice(sync.indexOf(start), sync.indexOf(end, sync.indexOf(start)));

    it('resume, reconnect and recovered all catch the viewed session up (messages shown + prompt queue reloaded)', () => {
        expect(body('private onWebResume = () => {', 'void apiSocket.checkLiveness();')).toContain('this.catchUpViewedSession();');
        expect(body('apiSocket.onReconnected(', 'apiSocket.onRecovered(')).toContain('this.catchUpViewedSession({ restart: !firstConnect });');
        expect(body('apiSocket.onRecovered(', 'private handleRelayCommittedMessages')).toContain('this.catchUpViewedSession();');
        const catchUp = body('private catchUpViewedSession(opts: { restart: boolean } = { restart: true }) {', 'private trackMessagesCatchUp(');
        expect(catchUp).toContain('this.trackMessagesCatchUp(viewing);');
        expect(catchUp).toContain('void reloadPromptQueue(viewing);');
        // B-803: resume/reconnect/recovered abort a stuck catch-up instead of coalescing behind it.
        expect(catchUp).toContain('this.onSessionEnter(viewing, { restartFetch: opts.restart });');
    });

    it('「重试」 restarts the stuck catch-up (B-803 restart), not a plain invalidate', () => {
        expect(body('retryMessagesCatchUp = (', 'private wirePromptQueueTranscript')).toContain('this.restartMessagesSync(sessionId);');
    });

    // B-803b (QA6 P1-1): with the socket down, 「重试」 did nothing for it — the probe skips a reconnecting manager.
    it('「重试」 with the socket down opens a fresh connect attempt, else probes', () => {
        expect(body('retryMessagesCatchUp = (', 'private wirePromptQueueTranscript')).toContain('if (!apiSocket.reconnectIfDown()) void apiSocket.checkLiveness();');
    });

    it('a seq gap shows the catch-up too', () => {
        expect(sync).toMatch(/if \(gap\) \{\s*this\.getMessagesSync\(sessionId\)\.invalidate\(\);\s*this\.trackMessagesCatchUp\(sessionId\);/);
        expect(sync).toMatch(/\} else if \(action === 'refetch'\) \{\s*this\.getMessagesSync\(sid\)\.invalidate\(\);\s*\/\/ B-804[^\n]*\n\s*this\.trackMessagesCatchUp\(sid\);/);
    });

    it('only the viewed session is shown, and it waits for the messages sync to drain', () => {
        expect(body('private trackMessagesCatchUp(', 'retryMessagesCatchUp')).toContain("if (storage.getState().currentViewingSessionId !== sessionId) return;\n        trackCatchUp(sessionId, this.getMessagesSync(sessionId).awaitQueue());");
    });

    it('the dock hand-off reads the transcript localIds and re-checks after every applied batch', () => {
        expect(sync).toContain('promptQueueTranscript.has = (sessionId, localId) => storage.getState().sessionMessages[sessionId]?.reducerState.localIds.has(localId) === true;');
        expect(sync).toContain('void messages.awaitQueue().then(() => settleDispatchedPrompts(sessionId, localIds));');
        expect(body('private applyMessages = (', 'private applySessions')).toContain('settleDispatchedPrompts(sessionId);');
    });
});
