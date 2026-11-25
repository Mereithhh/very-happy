import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_EVENT_GIVE_UP_MS, verifyPluginEvent } from '@slopus/happy-wire';
import { GAVE_UP, PluginEventHub } from './events';
import type { ServerOpResult } from './localApi';
import { installApproved, registryFor, sampleManifest, tempHome } from './testFixtures';

describe('B-974c events: notify + pull, signed push, retries, pull API (r4 §5.10, r5)', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    const event = (id = 'evt_1', type = 'decision.responded', attempt = 1) => ({
        id, type, attempt, installId: 'pi_hello-board', pluginId: 'hello-board', createdAt: 1,
        data: { itemId: 'a1', key: 'k', action: 'choose', choice: 'a', respondedAt: 1, actor: 'owner' },
    });

    function setup(opts: { callback?: boolean } = {}) {
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        const m = sampleManifest(opts.callback === false ? { callback: undefined } : {});
        installApproved(store, m);
        registry.reload();
        const key = registry.get('hello-board')!.secretKey!;
        let now = 1_795_577_286_000;
        let serverEvents: unknown[] = [];
        let online = true;
        const ops: Array<[string | null, string, Record<string, unknown>]> = [];
        const posts: Array<{ headers: Record<string, string>; body: string }> = [];
        let status = 200;
        const hub = new PluginEventHub({
            registry,
            serverOp: async (installId, op, payload): Promise<ServerOpResult> => {
                ops.push([installId, op, payload]);
                if (!online) return { kind: 'offline' };
                if (op === 'events.pull') return { kind: 'ok', result: { events: serverEvents, cursor: serverEvents.length ? 'c2' : null } };
                if (op === 'events.ack') return { kind: 'ok', result: { acked: 1 } };
                return { kind: 'ok', result: {} };
            },
            post: async (_url, headers, body) => { posts.push({ headers, body }); if (status < 0) throw new Error('ECONNREFUSED'); return status; },
            now: () => now,
        });
        const results = () => ops.filter((o) => o[1] === 'events.result').map((o) => o[2]);
        return { store, registry, key, hub, ops, posts, results, setEvents: (e: unknown[]) => { serverEvents = e; }, setStatus: (s: number) => { status = s; }, setOnline: (v: boolean) => { online = v; }, advance: (ms: number) => { now += ms; }, now: () => now };
    }

    it('events-due → events.pull → signed push → events.result delivered; events of another install are never pushed', async () => {
        const s = setup();
        s.setEvents([event(), { ...event('evt_x'), installId: 'pi_other' }]);
        await s.hub.onDue('pi_hello-board');
        await s.hub.onDue('pi_hello-board');
        expect(s.ops.filter((o) => o[1] === 'events.pull')[0]).toEqual(['pi_hello-board', 'events.pull', { limit: 100 }]);
        // Delivered once per pull; the foreign-install event is never pushed.
        expect(s.posts.map((p) => JSON.parse(p.body).id)).toEqual(['evt_1', 'evt_1']);
        const { headers, body } = s.posts[0];
        expect(headers['x-vh-event-id']).toBe('evt_1');
        expect(verifyPluginEvent({ secret: s.key, signature: headers['x-vh-signature'], timestamp: headers['x-vh-timestamp'], eventId: 'evt_1', rawBody: body, nowSec: Math.floor(s.now() / 1000) }).ok).toBe(true);
        expect(s.results()[0]).toEqual({ eventId: 'evt_1', status: 'delivered', attempt: 1 });
    });

    it('a pending in-flight event is not pushed again by a second notice', async () => {
        const s = setup();
        s.setStatus(500);
        s.setEvents([event()]);
        await s.hub.onDue('pi_hello-board');
        await s.hub.onDue('pi_hello-board');
        expect(s.posts).toHaveLength(1);
    });

    it.each([302, 404, 500, -1])('HTTP %i (or no answer) is a failed attempt; retries on the wire schedule, then gives up', async (code) => {
        const s = setup();
        s.setStatus(code);
        s.setEvents([event()]);
        await s.hub.onDue('pi_hello-board');
        expect(s.results()).toEqual([{ eventId: 'evt_1', status: 'failed', attempt: 1, error: code < 0 ? 'ECONNREFUSED' : `HTTP ${code}` }]);
        s.setEvents([]);
        s.advance(9_999); await s.hub.tick();
        expect(s.posts).toHaveLength(1);
        s.advance(1); await s.hub.tick();
        expect(s.posts).toHaveLength(2);
        expect(JSON.parse(s.posts[1].body).attempt).toBe(2);
        let elapsed = 10_000;
        for (const d of [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]) { s.advance(d); elapsed += d; await s.hub.tick(); }
        expect(elapsed).toBeLessThan(PLUGIN_EVENT_GIVE_UP_MS);
        expect(s.posts).toHaveLength(8);
        expect(s.results().filter((r) => r.error === GAVE_UP)).toEqual([]);
        s.advance(21_600_000); await s.hub.tick();
        expect(s.results().at(-1)).toMatchObject({ status: 'failed', error: GAVE_UP });
        expect(s.hub.pendingCount('pi_hello-board')).toBe(0);
        const count = s.posts.length;
        s.advance(PLUGIN_EVENT_GIVE_UP_MS); await s.hub.tick();
        expect(s.posts).toHaveLength(count);
    });

    it('a disabled plugin gets install.changed but not decision events', async () => {
        const s = setup();
        s.store.writeInstall('hello-board', { ...s.store.readInstall('hello-board')!, localDisabled: true });
        s.registry.reload();
        s.setEvents([event('evt_a'), { ...event('evt_b', 'install.changed'), data: { state: 'disabled', grants: [], manifestHash: 'h' } }]);
        await s.hub.onDue('pi_hello-board');
        expect(s.posts.map((p) => JSON.parse(p.body).id)).toEqual(['evt_b']);
    });

    it('pull API: forwards after/limit, signs each event over rawBody, long-polls until a due notice', async () => {
        const s = setup({ callback: false });
        const entry = s.registry.get('hello-board')!;
        s.setEvents([event('evt_1')]);
        const page = await s.hub.pull(entry, 'c1', 0);
        expect(s.ops.at(-1)).toEqual(['pi_hello-board', 'events.pull', { after: 'c1', limit: 100 }]);
        if (page.kind !== 'ok') throw new Error('expected ok');
        expect(page.cursor).toBe('c2');
        const pulled = page.events[0];
        expect(JSON.parse(pulled.rawBody)).toEqual(pulled.event);
        expect(verifyPluginEvent({ secret: s.key, signature: pulled.signature, timestamp: pulled.timestamp, eventId: 'evt_1', rawBody: pulled.rawBody, nowSec: pulled.timestamp }).ok).toBe(true);
        // No callback: a due notice never pushes.
        await s.hub.onDue('pi_hello-board');
        expect(s.posts).toHaveLength(0);
        s.setEvents([]);
        const waiting = s.hub.pull(entry, 'c2', 5_000);
        setTimeout(() => { s.setEvents([event('evt_3')]); void s.hub.onDue('pi_hello-board'); }, 20);
        const woke = await waiting;
        expect(woke.kind === 'ok' && woke.events.map((e) => e.event.id)).toEqual(['evt_3']);
        s.setOnline(false);
        expect((await s.hub.pull(entry, undefined, 0)).kind).toBe('offline');
    });
});
