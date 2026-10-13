// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferredCommits, installDeferredCommitFlush, isUnloadFlush, type FlushReason } from './deferredCommit';

describe('deferredCommit (B-566)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const make = () => createDeferredCommits({ setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as never) });

    it('commits only when the window ends', () => {
        const q = make();
        const commit = vi.fn(); const revert = vi.fn();
        const h = q.schedule('archive:s1', { delayMs: 6000, commit, revert });
        vi.advanceTimersByTime(5999);
        expect(commit).not.toHaveBeenCalled();
        expect(h.isPending()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(commit).toHaveBeenCalledWith('timeout');
        expect(revert).not.toHaveBeenCalled();
        expect(h.isPending()).toBe(false);
    });

    it('undo inside the window reverts and never commits', () => {
        const q = make();
        const commit = vi.fn(); const revert = vi.fn();
        const h = q.schedule('archive:s1', { delayMs: 6000, commit, revert });
        vi.advanceTimersByTime(3000);
        expect(h.undo()).toBe(true);
        vi.advanceTimersByTime(10_000);
        expect(revert).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
    });

    it('undo after commit is refused (too late) and does not revert', () => {
        const q = make();
        const commit = vi.fn(); const revert = vi.fn();
        const h = q.schedule('archive:s1', { delayMs: 6000, commit, revert });
        vi.advanceTimersByTime(6000);
        expect(h.undo()).toBe(false);
        expect(revert).not.toHaveBeenCalled();
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it('does not double-schedule the same key; commit runs once even if flushed twice', () => {
        const q = make();
        const commit = vi.fn();
        const a = q.schedule('archive:s1', { delayMs: 6000, commit, revert: vi.fn() });
        const b = q.schedule('archive:s1', { delayMs: 6000, commit, revert: vi.fn() });
        expect(b).toBe(a);
        a.flush('manual'); a.flush('manual');
        vi.advanceTimersByTime(10_000);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it('a throwing / rejecting commit is contained', async () => {
        const q = make();
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        q.schedule('a', { delayMs: 1, commit: () => { throw new Error('x'); }, revert: vi.fn() });
        q.schedule('b', { delayMs: 1, commit: () => Promise.reject(new Error('y')), revert: vi.fn() });
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it('keepalive reasons are exactly the page-exit ones', () => {
        const all: FlushReason[] = ['timeout', 'pagehide', 'beforeunload', 'hidden', 'manual'];
        expect(all.filter(isUnloadFlush)).toEqual(['pagehide', 'beforeunload', 'hidden']);
    });

    describe('page-exit flushing', () => {
        it.each([
            ['pagehide', () => window.dispatchEvent(new Event('pagehide')), 'pagehide'],
            ['beforeunload', () => window.dispatchEvent(new Event('beforeunload')), 'beforeunload'],
        ] as const)('%s commits every pending item immediately', (_n, fire, reason) => {
            const q = make();
            const uninstall = installDeferredCommitFlush(q);
            const c1 = vi.fn(); const c2 = vi.fn();
            q.schedule('archive:a', { delayMs: 6000, commit: c1, revert: vi.fn() });
            q.schedule('archive:b', { delayMs: 6000, commit: c2, revert: vi.fn() });
            fire();
            expect(c1).toHaveBeenCalledWith(reason);
            expect(c2).toHaveBeenCalledWith(reason);
            expect(q.pendingKeys()).toEqual([]);
            uninstall();
        });

        it('visibility hidden commits; visible does not', () => {
            const q = make();
            let state: DocumentVisibilityState = 'visible';
            const listeners: Array<() => void> = [];
            const doc = {
                get visibilityState() { return state; },
                addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
                removeEventListener: () => {},
            } as unknown as Document;
            const uninstall = installDeferredCommitFlush(q, window, doc);
            const commit = vi.fn();
            q.schedule('archive:a', { delayMs: 6000, commit, revert: vi.fn() });
            listeners.forEach((fn) => fn());
            expect(commit).not.toHaveBeenCalled();
            state = 'hidden';
            listeners.forEach((fn) => fn());
            expect(commit).toHaveBeenCalledWith('hidden');
            uninstall();
        });

        it('install is idempotent per queue (no double commit listeners)', () => {
            const q = make();
            const u1 = installDeferredCommitFlush(q);
            const u2 = installDeferredCommitFlush(q);
            expect(u2).toBe(u1);
            const commit = vi.fn();
            q.schedule('k', { delayMs: 6000, commit, revert: vi.fn() });
            window.dispatchEvent(new Event('pagehide'));
            expect(commit).toHaveBeenCalledTimes(1);
            u1();
        });
    });
});
