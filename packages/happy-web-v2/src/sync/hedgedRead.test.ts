/**
 * B-803b: hedged catch-up reads. Each attempt below stands for one connection:
 * `dead` never answers (only its abort settles it), `live` answers when told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armHedgeBurst, HEDGE_AFTER_MS, HEDGE_BURST_MS, HEDGE_MAX_ATTEMPTS, hedgedRead, hedgePoolInit, resetHedgePreference, type HedgedRequestInit } from './hedgedRead';

type Attempt = { index: number; init: HedgedRequestInit; signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void; headers: () => void };

function attempts() {
    const list: Attempt[] = [];
    const run = (signal: AbortSignal, init: HedgedRequestInit, index: number) => new Promise<string>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        list.push({ index, init, signal, resolve, reject, headers: init.onResponse });
    });
    return { list, run };
}

beforeEach(() => { vi.useFakeTimers(); resetHedgePreference(); });
afterEach(() => { vi.useRealTimers(); });

describe('hedgedRead', () => {
    it('a healthy read is one request: no hedge ever starts', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(40);
        a.list[0].resolve('page');
        await expect(read).resolves.toBe('page');
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 10);
        expect(a.list).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a read stuck on a dead connection gets a parallel attempt after HEDGE_AFTER_MS; the winner aborts the rest', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1);
        expect(a.list).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(a.list.map((x) => x.index)).toEqual([0, 1]);
        a.list[1].resolve('from the second connection');
        await expect(read).resolves.toBe('from the second connection');
        expect(a.list[0].signal.aborted).toBe(true);
        expect(a.list[1].signal.aborted).toBe(false);
    });

    it('skips up to HEDGE_MAX_ATTEMPTS - 1 dead connections, never more attempts than that', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 10);
        expect(a.list).toHaveLength(HEDGE_MAX_ATTEMPTS);
        a.list[HEDGE_MAX_ATTEMPTS - 1].resolve('fourth');
        await expect(read).resolves.toBe('fourth');
        expect(a.list.slice(0, -1).every((x) => x.signal.aborted)).toBe(true);
    });

    it('a slow but live first attempt is not cut short by the hedges', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 3);
        expect(a.list[0].signal.aborted).toBe(false);
        a.list[0].resolve('slow');
        await expect(read).resolves.toBe('slow');
    });

    it('a failure while another attempt runs waits for it; the last failure rejects (the caller backs off)', async () => {
        const a = attempts();
        const read = hedgedRead(a.run, { maxAttempts: 2 });
        const settled = vi.fn();
        read.then(settled, settled);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        a.list[0].reject(new TypeError('Failed to fetch'));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).not.toHaveBeenCalled();
        a.list[1].reject(new Error('Failed to forward-sync s1: 500'));
        await expect(read).rejects.toThrow('500');
    });

    it('a failure with nothing else running rejects at once — no hedge storm on a failing server', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        a.list[0].reject(new Error('Failed to forward-sync s1: 503'));
        await expect(read).rejects.toThrow('503');
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 10);
        expect(a.list).toHaveLength(1);
    });

    it('the caller abort (restart) aborts every attempt and rejects with its reason', async () => {
        const a = attempts();
        const outer = new AbortController();
        const read = hedgedRead(a.run, { signal: outer.signal });
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        const reason = new DOMException('Superseded by restart', 'AbortError');
        outer.abort(reason);
        await expect(read).rejects.toBe(reason);
        expect(a.list.every((x) => x.signal.aborted)).toBe(true);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 10);
        expect(a.list).toHaveLength(2);
    });
});

describe('B-818: hedging stops at the first response headers', () => {
    it('headers before HEDGE_AFTER_MS: a long body download never gets a hedge', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(300);
        a.list[0].headers();
        expect(vi.getTimerCount()).toBe(0);
        // ~9s of a 1.8MB body at 200KB/s
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 5);
        expect(a.list).toHaveLength(1);
        a.list[0].resolve('the whole list');
        await expect(read).resolves.toBe('the whole list');
    });

    it('a hedge whose headers arrive first commits: the waiting attempts are aborted, no further hedge', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        expect(a.list).toHaveLength(2);
        a.list[1].headers();
        expect(a.list[0].signal.aborted).toBe(true);
        expect(a.list[1].signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 5);
        expect(a.list).toHaveLength(2);
        a.list[1].resolve('second');
        await expect(read).resolves.toBe('second');
    });

    it('after the commit only the committed attempt decides; its failure rejects at once (caller backs off)', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        a.list[0].headers();
        expect(a.list[1].signal.aborted).toBe(true);
        a.list[0].reject(new DOMException('Response body stalled for 10000ms', 'TimeoutError'));
        await expect(read).rejects.toThrow('stalled');
    });

    it('a second onResponse (a late attempt) changes nothing', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        a.list[0].headers();
        a.list[1].headers();
        expect(a.list[0].signal.aborted).toBe(false);
        a.list[0].resolve('first');
        await expect(read).resolves.toBe('first');
    });
});

describe('connection pools: each hedge must reach another connection', () => {
    it('every attempt bypasses the HTTP cache (Chrome parks same-URL GETs behind the first one)', () => {
        expect(hedgePoolInit(0).cache).toBe('no-store');
        expect(hedgePoolInit(1).cache).toBe('no-store');
    });
    it('the second pool omits credentials: its own connection, not the one dead h2 session', () => {
        expect(hedgePoolInit(0).credentials).toBeUndefined();
        expect(hedgePoolInit(1).credentials).toBe('omit');
    });
    it('attempts alternate pools', async () => {
        const a = attempts();
        void hedgedRead(a.run).catch(() => {});
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 10);
        expect(a.list.map((x) => x.init.credentials)).toEqual([undefined, 'omit', undefined, 'omit']);
    });
    it('after a hedge on the other pool won, the next read starts on that pool', async () => {
        const first = attempts();
        const read = hedgedRead(first.run);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        first.list[1].resolve('omit pool');
        await read;
        const next = attempts();
        const second = hedgedRead(next.run);
        expect(next.list[0].init.credentials).toBe('omit');
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        expect(next.list[1].init.credentials).toBeUndefined();
        next.list[0].resolve('ok');
        await second;
    });
    it('a first attempt that wins keeps the preference', async () => {
        const a = attempts();
        const read = hedgedRead(a.run);
        a.list[0].resolve('ok');
        await read;
        const b = attempts();
        void hedgedRead(b.run);
        expect(b.list[0].init.credentials).toBeUndefined();
        b.list[0].resolve('ok');
    });
});

// QA7 O-1: 「重试」 restarted the read onto a dead h1 keep-alive; the hedge came
// HEDGE_AFTER_MS later, and a second restart in that window started over (~4.2s).
describe('hedgedRead burst after 「重试」 (QA7 O-1)', () => {
    it('inside the burst window both pools go out at once; the live one answers without waiting HEDGE_AFTER_MS', async () => {
        armHedgeBurst();
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(0);
        // B-818: each attempt's init also carries its onResponse (commit) hook.
        expect(a.list.map(({ init: { onResponse: _commit, ...pool } }) => pool)).toEqual([hedgePoolInit(0), hedgePoolInit(1)]);
        a.list[1].resolve('fresh connection');
        await expect(read).resolves.toBe('fresh connection');
        expect(a.list[0].signal.aborted).toBe(true);
    });

    it('a restart inside the window (the reconnect after the retry) is immediate again — the clock does not start over', async () => {
        armHedgeBurst();
        const first = attempts();
        const controller = new AbortController();
        const stale = hedgedRead(first.run, { signal: controller.signal });
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS - 1);
        controller.abort(new DOMException('Superseded by restart', 'AbortError'));
        await expect(stale).rejects.toThrow();
        const second = attempts();
        const read = hedgedRead(second.run);
        await vi.advanceTimersByTimeAsync(0);
        expect(second.list).toHaveLength(2);
        second.list[1].resolve('ok');
        await expect(read).resolves.toBe('ok');
    });

    it('B-818 × O-1: in a burst both pools go out; the first headers commit, the other is aborted, no third attempt', async () => {
        armHedgeBurst();
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(0);
        expect(a.list).toHaveLength(2);
        a.list[1].headers(); // the fresh connection answers first; its body is still downloading
        expect(a.list[0].signal.aborted).toBe(true);
        expect(a.list[1].signal.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 5);
        expect(a.list).toHaveLength(2);
        a.list[1].resolve('fresh connection');
        await expect(read).resolves.toBe('fresh connection');
    });

    it('B-818 × O-1: headers on the first attempt before the burst timer fires → the second pool never goes out', async () => {
        armHedgeBurst();
        const a = attempts();
        const read = hedgedRead(a.run);
        a.list[0].headers();
        await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS);
        expect(a.list).toHaveLength(1);
        a.list[0].resolve('first');
        await expect(read).resolves.toBe('first');
    });

    it('headers reported inside the attempt call itself (a cached response) commit before anything is scheduled — in a burst too', async () => {
        for (const burst of [false, true]) {
            if (burst) armHedgeBurst();
            const a = attempts();
            const read = hedgedRead((signal, init, index) => {
                const result = a.run(signal, init, index);
                init.onResponse();
                return result;
            });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(HEDGE_AFTER_MS * 3);
            expect(a.list).toHaveLength(1);
            a.list[0].resolve('cached');
            await expect(read).resolves.toBe('cached');
        }
    });

    it('after the window the normal schedule is back (a healthy read stays one request)', async () => {
        armHedgeBurst();
        await vi.advanceTimersByTimeAsync(HEDGE_BURST_MS);
        const a = attempts();
        const read = hedgedRead(a.run);
        await vi.advanceTimersByTimeAsync(40);
        expect(a.list).toHaveLength(1);
        a.list[0].resolve('page');
        await expect(read).resolves.toBe('page');
    });
});
