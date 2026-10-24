/**
 * B-803 (B-802 PR-1): message catch-up can no longer hang forever.
 *
 * The four required mechanisms, driven through the real pieces
 * (InvalidateSync + catchUpForward + fetchWithDeadline + AsyncLock) with a
 * fake fetch that, like the browser's, only settles when its signal aborts:
 *  1. a never-returning GET is aborted on restart() and re-issued at once;
 *  2. live messages still apply while a GET hangs (lock not held across it);
 *  3. lastSeq never moves backwards when an older page lands late;
 *  4. a timed-out GET is retried with backoff.
 * Plus the sync.ts wiring that routes resume / reconnect / recovered / back
 * online into restart(), and the offline guard.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidateSync } from '@/utils/sync';
import { AsyncLock } from '@/utils/lock';
import { catchUpForward, mergeFetchedLastSeq, type CatchUpPage } from './messageCatchUp';
import { createRequestDeadline, fetchWithDeadline, RequestTimeoutError, SYNC_READ_TIMEOUT_MS } from './requestDeadline';

type Msg = { seq: number };

/** A fetch whose responses are released by the test; aborting rejects like a browser fetch. */
function controllableFetch() {
    const calls: Array<{ url: string; signal: AbortSignal; respond: (page: CatchUpPage) => void }> = [];
    const impl = ((url: string, init?: RequestInit) => new Promise<Response>((resolveFetch, reject) => {
        const signal = init!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        calls.push({
            url,
            signal,
            respond: (page) => resolveFetch({ ok: true, status: 200, json: async () => page } as Response),
        });
    })) as unknown as typeof fetch;
    return { impl, calls };
}

function harness(opts?: { lastSeq?: number }) {
    const fetcher = controllableFetch();
    const lock = new AsyncLock();
    const applied: number[] = [];
    let lastSeq: number | undefined = opts?.lastSeq ?? 10;
    const run = (signal: AbortSignal) => catchUpForward<Msg>({
        fetchPage: async (afterSeq, pageSignal) => {
            const response = await fetchWithDeadline(fetcher.impl, `/messages?after_seq=${afterSeq}`, { signal: pageSignal, timeoutMs: SYNC_READ_TIMEOUT_MS });
            return await response.json() as CatchUpPage;
        },
        normalize: async (page) => page.messages.map((m) => ({ seq: m.seq })),
        withLock: (fn) => lock.inLock(fn),
        apply: (messages) => { for (const m of messages) applied.push(m.seq); },
        getLastSeq: () => lastSeq,
        setLastSeq: (seq) => { lastSeq = seq; },
    }, lastSeq!, signal);
    const sync = new InvalidateSync(run);
    /** The live socket fast path: applies under the same lock, advances lastSeq. */
    const live = (seq: number) => lock.inLock(() => {
        applied.push(seq);
        lastSeq = seq;
    });
    return { fetcher, lock, applied, sync, live, getLastSeq: () => lastSeq };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('B-803 catch-up restart: a stuck GET is aborted and re-issued at once', () => {
    it('restart() aborts the never-returning request and sends a new GET within 10ms', async () => {
        const h = harness();
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fetcher.calls).toHaveLength(1);
        const stuck = h.fetcher.calls[0];

        // Tab back in the foreground 3s later: the dead request is still pending.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(stuck.signal.aborted).toBe(false);
        h.sync.restart();
        await vi.advanceTimersByTimeAsync(10);

        expect(stuck.signal.aborted).toBe(true);
        expect(h.fetcher.calls).toHaveLength(2);
        expect(h.fetcher.calls[1].url).toBe('/messages?after_seq=10');

        h.fetcher.calls[1].respond({ messages: [{ seq: 11 }, { seq: 12 }], hasMore: false });
        await vi.advanceTimersByTimeAsync(10);
        expect(h.applied).toEqual([11, 12]);
        expect(h.getLastSeq()).toBe(12);
    });

    it('plain invalidate() still coalesces behind the in-flight request (no abort)', async () => {
        const h = harness();
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.fetcher.calls).toHaveLength(1);
        expect(h.fetcher.calls[0].signal.aborted).toBe(false);
    });

    it('restart() during a backoff sleep retries now instead of after the sleep', async () => {
        const h = harness();
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        // First attempt times out → backoff sleep starts.
        await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS);
        expect(h.fetcher.calls).toHaveLength(1);
        h.sync.restart();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.fetcher.calls).toHaveLength(2);
    });
});

describe('B-803 lock is not held across the network', () => {
    it('live messages apply while a catch-up GET hangs', async () => {
        const h = harness();
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fetcher.calls).toHaveLength(1);

        let liveDone = false;
        void h.live(11).then(() => { liveDone = true; });
        await vi.advanceTimersByTimeAsync(5);
        expect(liveDone).toBe(true);
        expect(h.applied).toEqual([11]);
        expect(h.fetcher.calls[0].signal.aborted).toBe(false);
    });
});

describe('B-803 lastSeq never moves backwards', () => {
    it('a late page ending below the live-advanced lastSeq does not regress it', async () => {
        const h = harness();
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        // Live path runs ahead to 15 while the GET (after_seq=10) is out.
        for (const seq of [11, 12, 13, 14, 15]) await h.live(seq);
        h.fetcher.calls[0].respond({ messages: [{ seq: 11 }, { seq: 12 }], hasMore: false });
        await vi.advanceTimersByTimeAsync(10);
        expect(h.getLastSeq()).toBe(15);
    });

    it('mergeFetchedLastSeq is monotonic', () => {
        expect(mergeFetchedLastSeq(undefined, 7)).toBe(7);
        expect(mergeFetchedLastSeq(9, 7)).toBe(9);
        expect(mergeFetchedLastSeq(7, 9)).toBe(9);
    });
});

describe('B-803 request deadline', () => {
    it('a timed-out GET is retried with backoff (not hammered, not abandoned)', async () => {
        const h = harness();
        h.sync.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fetcher.calls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS - 1);
        expect(h.fetcher.calls[0].signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.fetcher.calls[0].signal.aborted).toBe(true);
        expect(h.fetcher.calls[0].signal.reason).toBeInstanceOf(RequestTimeoutError);
        // Backoff: first retry after 125–250ms, not immediately.
        expect(h.fetcher.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(h.fetcher.calls).toHaveLength(2);
        h.fetcher.calls[1].respond({ messages: [{ seq: 11 }], hasMore: false });
        await vi.advanceTimersByTimeAsync(10);
        expect(h.applied).toEqual([11]);
    });

    it('the deadline still covers the body read after headers arrived', async () => {
        const deadline = createRequestDeadline({ timeoutMs: 1_000 });
        expect(deadline.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(deadline.signal.aborted).toBe(true);
    });

    it('a caller abort propagates; no timeout means no timer', async () => {
        const outer = new AbortController();
        const deadline = createRequestDeadline({ signal: outer.signal });
        outer.abort(new Error('caller'));
        expect(deadline.signal.aborted).toBe(true);
        expect((deadline.signal.reason as Error).message).toBe('caller');
        const none = createRequestDeadline({});
        await vi.advanceTimersByTimeAsync(60_000);
        expect(none.signal.aborted).toBe(false);
    });
});

describe('B-803 wiring in sync.ts / apiSocket.ts', () => {
    const sync = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');
    const api = readFileSync(resolve(__dirname, 'apiSocket.ts'), 'utf8');
    const queue = readFileSync(resolve(__dirname, 'promptQueue.ts'), 'utf8');

    function block(src: string, anchor: string, length = 2_400) {
        const at = src.indexOf(anchor);
        expect(at).toBeGreaterThanOrEqual(0);
        return src.slice(at, at + length);
    }

    it('tab resume restarts the viewed session catch-up', () => {
        expect(block(sync, 'private onWebResume = () => {', 600)).toContain('this.onSessionEnter(current, { restartFetch: true });');
    });

    it('socket reconnect and recovered restart it too', () => {
        const reconnected = block(sync, 'apiSocket.onReconnected(() => {');
        expect(reconnected.slice(0, reconnected.indexOf('apiSocket.onRecovered('))).toContain('if (viewing) this.onSessionEnter(viewing, { restartFetch: true });');
        expect(block(sync, 'apiSocket.onRecovered(() => {', 500)).toContain('if (viewing) this.onSessionEnter(viewing, { restartFetch: true });');
    });

    it('onSessionEnter routes restartFetch to restart(), and back-online restarts deferred catch-ups', () => {
        expect(block(sync, 'onSessionEnter = (sessionId: string, opts', 300)).toContain('if (opts?.restartFetch) {\n            this.restartMessagesSync(sessionId);');
        expect(block(sync, 'private restartMessagesSync(sessionId: string) {', 200)).toContain('this.getMessagesSync(sessionId).restart();');
        expect(block(sync, 'onRecovered: () => {', 300)).toContain('this.restartDeferredCatchUps();');
    });

    it('the messages InvalidateSync passes its abort signal into fetchMessages', () => {
        expect(sync).toContain('new InvalidateSync((signal) => this.fetchMessages(sessionId, signal))');
    });

    it('offline: no catch-up request, the session is remembered for recovery', () => {
        const fetchMessages = block(sync, 'private fetchMessages = async', 800);
        expect(fetchMessages).toContain('if (isNetworkOffline()) {');
        expect(fetchMessages).toContain('this.messagesDeferredOffline.add(sessionId);\n            return;');
    });

    it('fetchMessages does not wrap the network in the session lock', () => {
        const fetchMessages = block(sync, 'private fetchMessages = async', 2_200);
        expect(fetchMessages.slice(0, fetchMessages.indexOf('private restartMessagesSync'))).not.toContain('inLock');
    });

    it('catch-up reads carry the timeout', () => {
        expect(block(sync, 'private fetchHistoryPage = async', 400)).toContain('{ signal, timeoutMs: SYNC_READ_TIMEOUT_MS }');
        expect(block(sync, 'private fetchForwardSince = async', 800)).toContain('{ signal: pageSignal, timeoutMs: SYNC_READ_TIMEOUT_MS }');
        expect(block(sync, 'private fetchSessions = async', 800)).toContain('timeoutMs: SYNC_READ_TIMEOUT_MS,');
        expect(queue).toContain("timeoutMs: !init?.method || init.method === 'GET' ? SYNC_READ_TIMEOUT_MS : undefined,");
        expect(block(api, 'async request(path: string', 800)).toContain('return fetchWithDeadline(fetch, url, {');
    });
});
