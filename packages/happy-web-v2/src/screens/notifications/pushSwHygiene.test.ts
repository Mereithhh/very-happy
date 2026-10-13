/**
 * B-569: runs the REAL public/push-sw.js in a fake ServiceWorkerGlobalScope
 * (node:vm, same harness idea as pushSwBadge.test.ts) and pins:
 *  - per-target tag + renotify (same session → replace, still alert);
 *  - the seen-watermark sweep via getNotifications() (covered → closed,
 *    uncovered / unknown age / this push's own tag → kept);
 *  - old-server payloads (no seen) sweep nothing; a failing sweep still shows.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../../../public/push-sw.js', import.meta.url)), 'utf8');

interface FakeNotification {
    title: string;
    tag?: string;
    data?: Record<string, unknown>;
    timestamp?: number;
    renotify?: boolean;
    closed: boolean;
    close(): void;
}

function makeScope(opts: { live?: Array<Partial<FakeNotification>>; getNotificationsThrows?: boolean } = {}) {
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const live: FakeNotification[] = (opts.live ?? []).map((n) => ({
        title: 'old',
        closed: false,
        close() { this.closed = true; },
        ...n,
    }));
    const order: string[] = [];
    const registration = {
        showNotification: async (title: string, o: Record<string, unknown>) => {
            order.push('show');
            const n: FakeNotification = {
                title,
                tag: o.tag as string | undefined,
                data: o.data as Record<string, unknown>,
                renotify: o.renotify as boolean | undefined,
                closed: false,
                close() { this.closed = true; },
            };
            // Same-tag replacement, as browsers do.
            if (n.tag) for (const x of live) if (x.tag === n.tag) x.closed = true;
            live.push(n);
        },
        getNotifications: async () => {
            order.push('get');
            if (opts.getNotificationsThrows) throw new Error('boom');
            return live.filter((n) => !n.closed);
        },
    };
    const scope: Record<string, unknown> = {
        addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
        registration,
        clients: { matchAll: async () => [] },
        navigator: {},
        caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
        Response,
        Date: { now: () => 5_000_000 },
    };
    scope.self = scope;
    vm.runInNewContext(SRC, scope);
    const push = async (payload: unknown) => {
        const waits: Promise<unknown>[] = [];
        for (const fn of listeners.push ?? []) {
            fn({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
        }
        await Promise.all(waits);
    };
    const shown = () => live.filter((n) => !n.closed);
    return { scope: scope as Record<string, any>, push, live, shown, order };
}

describe('push-sw.js pure helpers (B-569)', () => {
    const { scope } = makeScope();

    it('vhTargetKeyOfUrl matches targetKeyOfPath rules', () => {
        expect(scope.vhTargetKeyOfUrl('/session/abc')).toBe('abc');
        expect(scope.vhTargetKeyOfUrl('/session/a%20b')).toBe('a b');
        expect(scope.vhTargetKeyOfUrl('/session/pending-1')).toBeNull();
        expect(scope.vhTargetKeyOfUrl('/terminal/m1?tid=t1')).toBe('t:t1');
        expect(scope.vhTargetKeyOfUrl('/terminal/m1?x=1&tid=t2')).toBe('t:t2');
        expect(scope.vhTargetKeyOfUrl('/terminal/m1')).toBeNull();
        expect(scope.vhTargetKeyOfUrl('/settings/notifications')).toBeNull();
        expect(scope.vhTargetKeyOfUrl('https://x/session/abc')).toBeNull();
        expect(scope.vhTargetKeyOfUrl(undefined)).toBeNull();
    });

    it('vhNotificationTag: session / terminal / test / none', () => {
        expect(scope.vhNotificationTag({ data: { sessionId: 's1', url: '/session/s1' } })).toBe('session:s1');
        expect(scope.vhNotificationTag({ data: { url: '/session/s2' } })).toBe('session:s2');
        expect(scope.vhNotificationTag({ data: { url: '/terminal/m?tid=t9' } })).toBe('terminal:t9');
        expect(scope.vhNotificationTag({ data: { kind: 'test', url: '/settings/notifications' } })).toBe('vh-test');
        expect(scope.vhNotificationTag({ data: {} })).toBeNull();
        expect(scope.vhNotificationTag({})).toBeNull();
    });

    it('vhKeyOfNotification reads new tags, data.key, and old SW url-only notifications', () => {
        expect(scope.vhKeyOfNotification({ tag: 'session:s1' })).toBe('s1');
        expect(scope.vhKeyOfNotification({ tag: 'terminal:t1' })).toBe('t:t1');
        expect(scope.vhKeyOfNotification({ tag: '', data: { key: 'k' } })).toBe('k');
        expect(scope.vhKeyOfNotification({ data: { url: '/session/old' } })).toBe('old');
        expect(scope.vhKeyOfNotification({ tag: 'session:' })).toBeNull();
    });

    it('vhStaleNotifications: covered closed; uncovered / unknown age / own tag kept', () => {
        const seen = { a: 100, b: 100, t: 100 };
        const list = [
            { tag: 'session:a', data: { createdAt: 90 } },      // covered
            { tag: 'session:b', data: { createdAt: 110 } },     // newer than the visit
            { tag: 'session:c', data: { createdAt: 10 } },      // never seen
            { data: { url: '/session/a' }, timestamp: 100 },     // old SW, equal → covered
            { data: { url: '/session/a' } },                     // no age → keep
            { tag: 'session:t', data: { createdAt: 1 } },       // own tag → keep
        ];
        const stale = scope.vhStaleNotifications(list, seen, 'session:t');
        expect(stale).toEqual([list[0], list[3]]);
    });

    it('vhParseSeen drops junk', () => {
        expect(scope.vhParseSeen({ a: 1, b: -1, c: 'x', d: NaN })).toEqual({ a: 1 });
        expect(scope.vhParseSeen([1])).toEqual({});
        expect(scope.vhParseSeen(null)).toEqual({});
    });
});

describe('push-sw.js push handler (B-569)', () => {
    it('same session: the newer notification replaces the older and re-alerts', async () => {
        const s = makeScope();
        await s.push({ title: 'first', data: { sessionId: 's1', url: '/session/s1', kind: 'permission' } });
        await s.push({ title: 'second', data: { sessionId: 's1', url: '/session/s1', kind: 'done' } });
        expect(s.shown().map((n) => n.title)).toEqual(['second']);
        expect(s.shown()[0].tag).toBe('session:s1');
        expect(s.shown()[0].renotify).toBe(true);
        await s.push({ title: 'other', data: { sessionId: 's2', kind: 'done' } });
        expect(s.shown().map((n) => n.title)).toEqual(['second', 'other']);
    });

    it('no target → no tag and no renotify (renotify without tag throws in browsers)', async () => {
        const s = makeScope();
        await s.push({ title: 'x', data: {} });
        expect(s.shown()[0].tag).toBeUndefined();
        expect(s.shown()[0].renotify).toBeUndefined();
    });

    it('old CLI without url: session push still deep-links; createdAt = sentAt', async () => {
        const s = makeScope();
        await s.push({ title: 'x', sentAt: 1234, data: { sessionId: 's9' } });
        expect(s.shown()[0].data).toMatchObject({ url: '/session/s9', key: 's9', createdAt: 1234 });
    });

    it('seen watermark closes covered notifications of OTHER targets, then shows', async () => {
        const s = makeScope({
            live: [
                { title: 'a-old', tag: 'session:a', data: { createdAt: 100 } },
                { title: 'b-new', tag: 'session:b', data: { createdAt: 500 } },
                { title: 'legacy', data: { url: '/session/a' }, timestamp: 50 },
            ],
        });
        await s.push({ title: 'c', sentAt: 600, data: { sessionId: 'c' }, seen: { a: 200, b: 200 } });
        expect(s.shown().map((n) => n.title)).toEqual(['b-new', 'c']);
        expect(s.order).toEqual(['get', 'show']);
    });

    it('a stale-looking watermark for THIS target never closes the new notification', async () => {
        const s = makeScope();
        // device clock ahead: seen[s1] is later than the server's sentAt
        await s.push({ title: 'new', sentAt: 100, data: { sessionId: 's1' }, seen: { s1: 999 } });
        expect(s.shown().map((n) => n.title)).toEqual(['new']);
    });

    it('old server payload (no seen) sweeps nothing and does not even query', async () => {
        const s = makeScope({ live: [{ title: 'a-old', tag: 'session:a', data: { createdAt: 1 } }] });
        await s.push({ title: 'n', data: { sessionId: 'z' } });
        expect(s.shown().map((n) => n.title)).toEqual(['a-old', 'n']);
        expect(s.order).toEqual(['show']);
    });

    it('a failing sweep still shows the notification', async () => {
        const s = makeScope({ getNotificationsThrows: true });
        await s.push({ title: 'n', data: { sessionId: 'z' }, seen: { a: 1 } });
        expect(s.shown().map((n) => n.title)).toEqual(['n']);
    });

    it('test push gets the vh-test tag', async () => {
        const s = makeScope();
        await s.push({ title: 't1', data: { kind: 'test', url: '/settings/notifications' } });
        await s.push({ title: 't2', data: { kind: 'test', url: '/settings/notifications' } });
        expect(s.shown().map((n) => [n.title, n.tag])).toEqual([['t2', 'vh-test']]);
    });
});
