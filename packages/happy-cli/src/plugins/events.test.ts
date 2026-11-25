import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginEventHub, RETRY_GIVE_UP_MS, nextRetryDelay } from './events';
import { verifyEventSignature } from './signing';
import { installApproved, registryFor, sampleManifest, tempHome } from './testFixtures';

describe('B-974c events: push with HMAC, retry schedule, pull (DESIGN §5.5)', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    function setup(opts: { callback?: boolean } = {}) {
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        const m = sampleManifest(opts.callback === false ? { callback: undefined } : {});
        const { secret } = installApproved(store, m);
        registry.reload();
        let now = 1_795_577_286_000;
        const results: Array<[string, string, number]> = [];
        const posts: Array<{ headers: Record<string, string>; body: string }> = [];
        let status = 200;
        const hub = new PluginEventHub({
            registry,
            reportResult: (_i, id, s, attempt) => results.push([id, s, attempt]),
            post: async (_url, headers, body) => { posts.push({ headers, body }); if (status < 0) throw new Error('ECONNREFUSED'); return status; },
            now: () => now,
        });
        return { store, registry, secret, hub, results, posts, setStatus: (s: number) => { status = s; }, advance: (ms: number) => { now += ms; }, now: () => now };
    }
    const event = (id = 'evt_1', type = 'decision.responded') => ({ id, type, installId: 'pi_hello-board', pluginId: 'hello-board', createdAt: 1, data: { key: 'k', action: 'choose', choice: 'a' } });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('delivers once with a signature the reference verifier accepts', async () => {
        const s = setup();
        expect(s.hub.receive(event())).toBe(true);
        expect(s.hub.receive(event())).toBe(true); // duplicate id ignored
        await flush();
        expect(s.posts).toHaveLength(1);
        const { headers, body } = s.posts[0];
        expect(headers['x-vh-event-id']).toBe('evt_1');
        expect(JSON.parse(body)).toMatchObject({ id: 'evt_1', attempt: 1 });
        expect(verifyEventSignature(s.secret, headers['x-vh-signature'], Number(headers['x-vh-timestamp']), 'evt_1', body, Math.floor(s.now() / 1000))).toBe(true);
        expect(s.results).toEqual([['evt_1', 'delivered', 1]]);
    });

    it('retries on 10 s, 1 min, 5 min, 30 min, 2 h, then 6 h; gives up after 24 h', async () => {
        expect([1, 2, 3, 4, 5, 6, 7].map(nextRetryDelay)).toEqual([10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]);
        const s = setup();
        s.setStatus(500);
        s.hub.receive(event());
        await flush();
        expect(s.posts).toHaveLength(1);
        s.advance(9_999); await s.hub.tick();
        expect(s.posts).toHaveLength(1);
        s.advance(1); await s.hub.tick();
        expect(s.posts).toHaveLength(2);
        let elapsed = 10_000;
        for (const d of [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]) { s.advance(d); elapsed += d; await s.hub.tick(); }
        expect(elapsed).toBeLessThan(RETRY_GIVE_UP_MS);
        expect(s.posts).toHaveLength(8);
        expect(s.results).toEqual([]);
        s.advance(21_600_000); await s.hub.tick();
        expect(s.results.at(-1)?.[1]).toBe('failed');
        const count = s.posts.length;
        s.advance(RETRY_GIVE_UP_MS); await s.hub.tick();
        expect(s.posts).toHaveLength(count);
        expect(s.hub.pendingCount('pi_hello-board')).toBe(0);
    });

    it.each([302, 404, 500])('HTTP %i from the callback is a failed attempt', async (code) => {
        const s = setup();
        s.setStatus(code);
        s.hub.receive(event());
        await flush();
        expect(s.posts).toHaveLength(1);
        expect(s.results).toEqual([]);
        expect(s.hub.pendingCount('pi_hello-board')).toBe(1);
        s.setStatus(-1);
        s.advance(10_000); await s.hub.tick();
        expect(s.posts).toHaveLength(2);
        expect(s.hub.pendingCount('pi_hello-board')).toBe(1);
    });

    it('a disabled plugin gets install.changed but not decision events', async () => {
        const s = setup();
        s.store.writeInstall('hello-board', { ...s.store.readInstall('hello-board')!, localDisabled: true });
        s.registry.reload();
        s.hub.receive(event('evt_a'));
        s.hub.receive(event('evt_b', 'install.changed'));
        await flush();
        expect(s.posts.map((p) => JSON.parse(p.body).id)).toEqual(['evt_b']);
    });

    it('pull: cursor, signature field, ack, long-poll wake-up', async () => {
        const s = setup({ callback: false });
        const entry = s.registry.get('hello-board')!;
        s.hub.receive(event('evt_1'));
        s.hub.receive(event('evt_2'));
        const page = await s.hub.list(entry, 0, 0);
        expect(page.events.map((e) => e.id)).toEqual(['evt_1', 'evt_2']);
        expect(page.cursor).toBe('2');
        const { signature, ...raw } = page.events[0];
        expect(verifyEventSignature(s.secret, signature!.value, signature!.timestamp, 'evt_1', JSON.stringify(raw), signature!.timestamp)).toBe(true);
        expect(s.hub.ack(entry, 1)).toBe(1);
        expect((await s.hub.list(entry, 0, 0)).events.map((e) => e.id)).toEqual(['evt_2']);
        expect(s.results).toEqual([['evt_1', 'delivered', 1]]);
        const waiting = s.hub.list(entry, 2, 5_000);
        setTimeout(() => s.hub.receive(event('evt_3')), 20);
        expect((await waiting).events.map((e) => e.id)).toEqual(['evt_3']);
        expect(s.posts).toHaveLength(0);
    });

    it('ignores events for another install or plugin', () => {
        const s = setup();
        expect(s.hub.receive({ ...event(), installId: 'pi_x' })).toBe(false);
        expect(s.hub.receive({ ...event(), pluginId: 'someone-else' })).toBe(false);
        expect(s.hub.receive({ nope: 1 })).toBe(false);
    });
});
