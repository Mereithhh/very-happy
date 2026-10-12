/**
 * Runs the REAL public/push-sw.js inside a fake ServiceWorkerGlobalScope
 * (node:vm) to pin the B-559 badge mechanism: the page-reported count is
 * persisted, a push with no visible window bumps it, a visible window or a
 * missing Badging API leaves the badge alone, and the notification is shown
 * in every case (a swallowed push gets the worker's permission revoked on iOS).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../../../public/push-sw.js', import.meta.url)), 'utf8');

function makeScope(opts: { badging?: boolean; visible?: boolean } = {}) {
    const clock = { now: 1_000_000 };
    const FakeDate = { now: () => clock.now };
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const store = new Map<string, string>();
    const badge: Array<number | undefined> = [];
    const shown: string[] = [];
    const scope = {
        addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
        registration: { showNotification: async (title: string) => { shown.push(title); } },
        clients: {
            matchAll: async () => (opts.visible ? [{ visibilityState: 'visible' }] : [{ visibilityState: 'hidden' }]),
        },
        navigator: opts.badging === false ? {} : { setAppBadge: async (n?: number) => { badge.push(n); } },
        caches: {
            open: async () => ({
                match: async (url: string) => (store.has(url) ? new Response(store.get(url)) : undefined),
                put: async (url: string, res: Response) => { store.set(url, await res.text()); },
            }),
        },
        Response,
        Date: FakeDate,
        JSON,
        Number,
        Math,
        Promise,
        String,
    };
    (scope as Record<string, unknown>).self = scope;
    vm.runInNewContext(SRC, scope);
    const fire = async (type: string, init: Record<string, unknown>) => {
        const waits: Promise<unknown>[] = [];
        for (const fn of listeners[type] ?? []) fn({ ...init, waitUntil: (p: Promise<unknown>) => waits.push(p) });
        await Promise.all(waits);
    };
    const push = () => fire('push', { data: { json: () => ({ title: 'T', body: '', data: { url: '/session/x' } }) } });
    const report = (count: unknown) => fire('message', { data: { type: 'vh-badge-count', count } });
    const advance = (ms: number) => { clock.now += ms; };
    return { push, report, badge, shown, store, advance };
}

describe('push-sw.js app badge (B-559)', () => {
    it('never reported → number-less flag on push', async () => {
        const s = makeScope();
        await s.push();
        expect(s.badge).toEqual([undefined]);
        expect(s.shown).toEqual(['T']);
    });

    it('reported count + 1 per push while no window is visible', async () => {
        const s = makeScope();
        await s.report(3);
        s.advance(60_000);
        await s.push();
        await s.push(); // the SW's own estimate is not "a page is alive" — keeps counting
        expect(s.badge).toEqual([4, 5]);
        await s.report(0); // page opened and read everything
        s.advance(60_000);
        await s.push();
        expect(s.badge).toEqual([4, 5, 1]);
    });

    it('a page report younger than 10s means a live (hidden) page owns the count — no +1', async () => {
        const s = makeScope();
        await s.report(3);
        s.advance(5_000);
        await s.push();
        expect(s.badge).toEqual([]);
        expect(s.shown).toEqual(['T']); // the notification itself still shows
        s.advance(6_000); // now 11s since the report
        await s.push();
        expect(s.badge).toEqual([4]);
    });

    it('a visible window keeps the exact count itself — SW does not touch it', async () => {
        const s = makeScope({ visible: true });
        await s.report(2);
        await s.push();
        expect(s.badge).toEqual([]);
        expect(s.shown).toEqual(['T']);
    });

    it('no Badging API in the worker → notification still shows, no error', async () => {
        const s = makeScope({ badging: false });
        await s.report(2);
        await s.push();
        expect(s.shown).toEqual(['T']);
    });

    it('ignores junk messages', async () => {
        const s = makeScope();
        await s.report(-1);
        await s.report('x');
        await s.push();
        expect(s.badge).toEqual([undefined]);
    });
});
