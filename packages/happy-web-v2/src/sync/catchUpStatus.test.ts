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
        // B-812: through the scheduler — sync-hello in subscribe mode, catchUpViewedSession() in legacy.
        const resume = body('private onWebResume = () => {', 'void apiSocket.checkLiveness();');
        expect(resume).toContain('this.syncScheduler.resume();');
        expect(resume).toContain('this.reloadViewedPromptQueue();');
        // B-803 in subscribe mode too: a REST catch-up stuck on the dead link is restarted at once.
        expect(resume).toMatch(/this\.restartStuckCatchUp\(\);\s*this\.syncScheduler\.resume\(\);/);
        const stuck = body('private restartStuckCatchUp(', 'private legacyCatchUp(');
        expect(stuck).toContain('if (!viewing || !messages?.isRunning()) return;');
        expect(stuck).toContain('if (opts?.firstConnect) messages.invalidate();\n        else this.restartMessagesSync(viewing);');
        const reconnected = body('apiSocket.onReconnected(', 'apiSocket.onRecovered(');
        expect(reconnected).toContain("return this.syncScheduler.connect('connect');");
        expect(reconnected).toContain('this.reloadViewedPromptQueue();');
        // B-823: the page's first connect keeps the boot's catch-up (no restart).
        expect(reconnected).toContain('this.restartStuckCatchUp({ firstConnect });');
        const recovered = body('apiSocket.onRecovered(', 'private handleRelayCommittedMessages');
        expect(recovered).toContain("void this.syncScheduler.connect('recovered');");
        expect(recovered).toContain('this.reloadViewedPromptQueue();');
        expect(body('private legacyCatchUp(', 'private onSyncPhase(')).toContain('this.catchUpViewedSession();');
        expect(body('private reloadViewedPromptQueue() {', 'private trackMessagesCatchUp(')).toContain('void reloadPromptQueue(viewing);');
        const catchUp = body('private catchUpViewedSession() {', 'private reloadViewedPromptQueue(');
        expect(catchUp).toContain('this.trackMessagesCatchUp(viewing);');
        // B-803: resume/reconnect/recovered abort a stuck catch-up instead of coalescing behind it.
        expect(catchUp).toContain('this.restartMessagesSync(viewing);');
        // B-812 M1: the session duties run on every link-back edge whatever the mode (behaviour: sessionSubscribe.test.ts).
        expect(resume).toContain('this.touchViewedSession();');
        expect(reconnected).toContain('this.touchViewedSession();');
        expect(recovered).toContain('this.touchViewedSession();');
    });

    it('「重试」 restarts the stuck catch-up (B-803 restart), not a plain invalidate', () => {
        expect(body('retryMessagesCatchUp = (', 'private wirePromptQueueTranscript')).toContain('this.restartMessagesSync(sessionId);');
    });

    // QA7 O-1: the restarted read goes out on both pools at once (hedgedRead burst), not HEDGE_AFTER_MS later.
    it('「重试」 on the REST path arms the hedge burst before restarting; subscribe mode says hello instead', () => {
        const retry = body('retryMessagesCatchUp = (', 'private wirePromptQueueTranscript');
        expect(retry).toContain('if (this.syncScheduler.retry(sessionId)) return;');
        expect(retry).toMatch(/armHedgeBurst\(\);\s*this\.restartMessagesSync\(sessionId\);/);
    });

    // B-803b (QA6 P1-1): with the socket down, 「重试」 did nothing for it — the probe skips a reconnecting manager.
    it('「重试」 with the socket down opens a fresh connect attempt, else probes', () => {
        expect(body('retryMessagesCatchUp = (', 'private wirePromptQueueTranscript')).toContain('if (!apiSocket.reconnectIfDown()) void apiSocket.checkLiveness();');
    });

    it('a seq gap shows the catch-up too', () => {
        // B-812: one gap path for every point source, after the reorder window.
        expect(sync).toMatch(/if \(!this\.syncScheduler\.gap\(sessionId\)\) \{\s*this\.getMessagesSync\(sessionId\)\.invalidate\(\);\s*\/\/ B-804[^\n]*\n\s*this\.trackMessagesCatchUp\(sessionId\);/);
    });

    it('only the viewed session is shown, and it waits for the messages sync to drain', () => {
        expect(body('private trackMessagesCatchUp(', 'retryMessagesCatchUp')).toContain("if (storage.getState().currentViewingSessionId !== sessionId) return;\n        trackCatchUp(sessionId, this.getMessagesSync(sessionId).awaitQueue());");
    });

    it('the dock hand-off reads the transcript localIds and re-checks after every applied batch', () => {
        expect(sync).toContain('promptQueueTranscript.has = (sessionId, localId) => storage.getState().sessionMessages[sessionId]?.reducerState.localIds.has(localId) === true;');
        expect(sync).toContain('void messages.awaitQueue().then(() => settleDispatchedPrompts(sessionId, localIds));');
        expect(body('private writeMessagesToStore = (', 'private applySessions')).toContain('settleDispatchedPrompts(sessionId);');
    });
});
