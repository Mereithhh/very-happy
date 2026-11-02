import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentPauseSignal, isReadyTimeout, ReadyTimeoutError, readyWithin, type PauseSignal } from './readyDeadline';

function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => Promise.resolve());

describe('readyWithin (B-859b)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('resolves as soon as ready resolves within the deadline', async () => {
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium');
        let done = false;
        void wait().then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(done).toBe(false);
        d.resolve();
        await flush();
        expect(done).toBe(true);
    });

    it('rejects with ReadyTimeoutError when ready never settles, instead of hanging', async () => {
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium');
        const result = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(11_999);
        await flush();
        const early = await Promise.race([result, Promise.resolve('pending')]);
        expect(early).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        const e = await result;
        expect(e).toBeInstanceOf(ReadyTimeoutError);
        expect((e as Error).message).toBe('libsodium not ready after 12000ms');
    });

    it('measures the deadline from creation, so retries after it fail fast rather than waiting again', async () => {
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium');
        await vi.advanceTimersByTimeAsync(20_000);
        const t0 = Date.now();
        const e = await wait().then(() => null, (err) => err);
        expect(e).toBeInstanceOf(ReadyTimeoutError);
        expect(Date.now() - t0).toBe(0);
    });

    it('a ready that arrives after the deadline still lets the next call succeed', async () => {
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium');
        const first = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(await first).toBeInstanceOf(ReadyTimeoutError);
        d.resolve();
        await flush();
        await expect(wait()).resolves.toBeUndefined();
    });

    it('propagates a ready rejection', async () => {
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium');
        const err = new Error('wasm failed');
        const result = wait().then(() => null, (e) => e);
        d.reject(err);
        expect(await result).toBe(err);
    });
});

/** A page whose visibility the test flips by hand. */
function fakePage(hidden = false) {
    const listeners = new Set<() => void>();
    const signal: PauseSignal = {
        paused: () => hidden,
        subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    return {
        signal,
        listeners,
        set(next: boolean) { hidden = next; for (const l of [...listeners]) l(); },
    };
}

async function state(p: Promise<unknown>) {
    await flush();
    return Promise.race([p, Promise.resolve('pending')]);
}

describe('readyWithin counts only visible time (B-859c)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('hidden time does not count: 5 s visible + 30 s hidden + 6.9 s visible is still pending', async () => {
        const page = fakePage();
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium', Date.now, page.signal);
        const result = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(5_000);
        page.set(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await state(result)).toBe('pending');
        page.set(false);
        await vi.advanceTimersByTimeAsync(6_999);
        expect(await state(result)).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBeInstanceOf(ReadyTimeoutError);
    });

    it('a call made right after a long suspension gets the remaining budget, not an instant reject (QA33 P2-2)', async () => {
        const page = fakePage();
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium', Date.now, page.signal);
        await vi.advanceTimersByTimeAsync(200);
        page.set(true);
        await vi.advanceTimersByTimeAsync(30_000);
        page.set(false);
        const result = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await state(result)).toBe('pending');
        d.resolve();
        expect(await result).toBe('resolved');
    });

    it('accumulates across several hidden/visible switches', async () => {
        const page = fakePage();
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium', Date.now, page.signal);
        const result = wait().then(() => 'resolved', (e) => e);
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(2_000); // visible: 2 s each → 10 s
            page.set(true);
            await vi.advanceTimersByTimeAsync(60_000);
            page.set(false);
        }
        expect(await state(result)).toBe('pending');
        await vi.advanceTimersByTimeAsync(1_999);
        expect(await state(result)).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBeInstanceOf(ReadyTimeoutError);
    });

    it('repeated hide/show at the same instant neither adds nor loses time', async () => {
        const page = fakePage();
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium', Date.now, page.signal);
        const result = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(6_000);
        page.set(false); // visible → visible: no-op
        page.set(true);
        page.set(true);
        page.set(false);
        await vi.advanceTimersByTimeAsync(5_999);
        expect(await state(result)).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBeInstanceOf(ReadyTimeoutError);
    });

    it('a page loaded in the background starts the clock only once it is shown', async () => {
        const page = fakePage(true);
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium', Date.now, page.signal);
        await vi.advanceTimersByTimeAsync(100_000);
        const result = wait().then(() => 'resolved', (e) => e);
        expect(await state(result)).toBe('pending');
        page.set(false);
        await vi.advanceTimersByTimeAsync(11_999);
        expect(await state(result)).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBeInstanceOf(ReadyTimeoutError);
        // Retries after the visible budget is spent still fail fast.
        const t0 = Date.now();
        expect(await wait().then(() => null, (e) => e)).toBeInstanceOf(ReadyTimeoutError);
        expect(Date.now() - t0).toBe(0);
    });

    it('a late ready after the visible deadline still lets the next call succeed', async () => {
        const page = fakePage();
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium', Date.now, page.signal);
        page.set(true);
        await vi.advanceTimersByTimeAsync(20_000);
        page.set(false);
        const first = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(await first).toBeInstanceOf(ReadyTimeoutError);
        d.resolve();
        await flush();
        await expect(wait()).resolves.toBeUndefined();
    });

    it('stops listening once ready settles', async () => {
        const page = fakePage();
        const d = deferred();
        readyWithin(d.promise, 12_000, 'libsodium', Date.now, page.signal);
        expect(page.listeners.size).toBe(1);
        d.resolve();
        await flush();
        expect(page.listeners.size).toBe(0);
    });
});

describe('documentPauseSignal (B-859c)', () => {
    function fakeDocument() {
        const target = new EventTarget() as EventTarget & { hidden: boolean };
        target.hidden = false;
        return target;
    }

    it('pauses while hidden and between freeze and resume, notifying on each change', () => {
        const doc = fakeDocument();
        const signal = documentPauseSignal(doc as unknown as Document);
        const seen: boolean[] = [];
        signal.subscribe(() => seen.push(signal.paused()));
        expect(signal.paused()).toBe(false);
        doc.hidden = true;
        doc.dispatchEvent(new Event('visibilitychange'));
        doc.dispatchEvent(new Event('freeze'));
        doc.hidden = false;
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(signal.paused()).toBe(true); // still frozen
        doc.dispatchEvent(new Event('resume'));
        expect(seen).toEqual([true, true, true, false]);
    });

    it('never pauses without a document', () => {
        expect(documentPauseSignal(undefined).paused()).toBe(false);
    });
});

describe('isReadyTimeout (B-859c)', () => {
    it('sees through SyncNotStartedError.reason and Error.cause', () => {
        const timeout = new ReadyTimeoutError('libsodium', 12_000);
        expect(isReadyTimeout(timeout)).toBe(true);
        expect(isReadyTimeout({ name: 'SyncNotStartedError', reason: timeout })).toBe(true);
        expect(isReadyTimeout(new Error('wrapped', { cause: timeout }))).toBe(true);
        expect(isReadyTimeout(new Error('offline'))).toBe(false);
        expect(isReadyTimeout(null)).toBe(false);
    });
});
