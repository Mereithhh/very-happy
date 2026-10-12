import { describe, expect, it, vi } from 'vitest';
import { applyAppBadge, BADGE_COUNT_MESSAGE, createBadgeSyncer, installVisibleResync, planBadge, type BadgeNavigatorLike } from './appBadge';

function fakeNav(opts: { badging?: boolean; controller?: boolean; reject?: boolean } = {}) {
    const calls: string[] = [];
    const posted: unknown[] = [];
    const nav: BadgeNavigatorLike = {};
    if (opts.badging !== false) {
        nav.setAppBadge = vi.fn(async (n?: number) => {
            calls.push(`set:${n}`);
            if (opts.reject) throw new Error('not installed');
        });
        nav.clearAppBadge = vi.fn(async () => {
            calls.push('clear');
            if (opts.reject) throw new Error('not installed');
        });
    }
    nav.serviceWorker = { controller: opts.controller === false ? null : { postMessage: (m: unknown) => posted.push(m) } };
    return { nav, calls, posted };
}

describe('planBadge', () => {
    it('positive → set, zero/negative/NaN → clear', () => {
        expect(planBadge(3)).toEqual({ kind: 'set', n: 3 });
        expect(planBadge(0)).toEqual({ kind: 'clear' });
        expect(planBadge(-2)).toEqual({ kind: 'clear' });
        expect(planBadge(Number.NaN)).toEqual({ kind: 'clear' });
    });
});

describe('applyAppBadge', () => {
    it('sets / clears and reports the count to the SW', () => {
        const { nav, calls, posted } = fakeNav();
        expect(applyAppBadge(nav, 4)).toBe(true);
        expect(applyAppBadge(nav, 0)).toBe(true);
        expect(calls).toEqual(['set:4', 'clear']);
        expect(posted).toEqual([
            { type: BADGE_COUNT_MESSAGE, count: 4 },
            { type: BADGE_COUNT_MESSAGE, count: 0 },
        ]);
    });

    it('is a silent no-op without the Badging API (still informs the SW)', () => {
        const { nav, posted } = fakeNav({ badging: false });
        expect(applyAppBadge(nav, 2)).toBe(false);
        expect(posted).toHaveLength(1);
        expect(applyAppBadge(undefined, 2)).toBe(false);
    });

    it('swallows rejections (not installed / no permission)', async () => {
        const { nav } = fakeNav({ reject: true });
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        expect(applyAppBadge(nav, 1)).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
    });

    it('does not post without a controlling SW', () => {
        const { nav, posted } = fakeNav({ controller: false });
        applyAppBadge(nav, 1);
        expect(posted).toHaveLength(0);
    });
});

describe('createBadgeSyncer', () => {
    it('only touches the badge when the count changes; reset re-applies', () => {
        const { nav, calls } = fakeNav();
        const s = createBadgeSyncer(() => nav);
        s.sync(2); s.sync(2); s.sync(3); s.sync(0); s.sync(0);
        expect(calls).toEqual(['set:2', 'set:3', 'clear']);
        s.reset();
        s.sync(0);
        expect(calls).toEqual(['set:2', 'set:3', 'clear', 'clear']);
    });
});

describe('installVisibleResync', () => {
    function fakeDoc() {
        const ls = new Set<() => void>();
        return {
            visibilityState: 'hidden' as DocumentVisibilityState,
            addEventListener: (_: string, fn: () => void) => { ls.add(fn); },
            removeEventListener: (_: string, fn: () => void) => { ls.delete(fn); },
            fire() { for (const l of ls) l(); },
            size: () => ls.size,
        };
    }
    it('becoming visible re-applies the SAME count (overwrites a SW push estimate)', () => {
        const { nav, calls, posted } = fakeNav();
        const s = createBadgeSyncer(() => nav);
        s.sync(2);
        const doc = fakeDoc();
        const off = installVisibleResync(doc as never, s, () => 2);
        doc.fire(); // hidden → nothing
        expect(calls).toEqual(['set:2']);
        doc.visibilityState = 'visible';
        doc.fire();
        expect(calls).toEqual(['set:2', 'set:2']);
        expect(posted).toHaveLength(2);
        off();
        expect(doc.size()).toBe(0);
    });
});
