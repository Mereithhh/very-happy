import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginRuntime, messageFromLogEntry, parseInstallView, pluginRpcHandlers, trackedPluginSessions } from './runtime';
import type { ServerOpResult, ServerPluginSupport } from './localApi';
import { manifestHash } from './manifest';
import { assertWirePluginOp, sampleManifest, tempHome } from './testFixtures';
import { PluginStore } from './store';

describe('B-974c runtime: capability gate, install.sync, queue replay, notices (r2/r4)', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    function setup() {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        const m = sampleManifest();
        store.writePending(m.id, m);
        store.writeInstall(m.id, { installId: 'pi_1', pluginId: m.id, state: 'pending', grants: [], approvedManifestHash: null, updatedAt: 1 });
        let online = true;
        let support: ServerPluginSupport = 'yes';
        let installs: unknown[] = [];
        const refuse = new Map<string, string>();
        const ops: Array<[string | null, string, Record<string, unknown>]> = [];
        const serverOp = vi.fn(async (installId: string | null, op: string, payload: Record<string, unknown>, requestId: string): Promise<ServerOpResult> => {
            assertWirePluginOp(installId, op, payload, requestId);
            ops.push([installId, op, payload]);
            if (!online) return { kind: 'offline' };
            if (refuse.has(op)) return { kind: 'error', status: 403, error: refuse.get(op)! };
            if (op === 'install.sync') return { kind: 'ok', result: { installs } };
            if (op === 'events.pull') return { kind: 'ok', result: { events: [], cursor: null } };
            return { kind: 'ok', result: {} };
        });
        const runtime = new PluginRuntime({ home: t.home, machineId: () => 'm1', serverOp, sessions: { list: () => [], isLocal: () => false, readMessages: async () => ({ messages: [], cursor: null }) }, probeServerSupport: async () => support });
        runtime.start(43210);
        const view = (state: string, grants: string[], hash: string | null) => ({ id: 'pi_1', pluginId: 'hello-board', state, grants, manifest: null, manifestHash: hash, pending: false });
        return { store, runtime, ops, m, view, refuse, setOnline: (v: boolean) => { online = v; }, setSupport: (v: ServerPluginSupport) => { support = v; }, setInstalls: (v: unknown[]) => { installs = v; } };
    }

    it('plugin-install-changed { installId } → install.sync → promotes the matching pending manifest and creates credentials', async () => {
        const s = setup();
        expect(s.store.readFileJson('hello-board', 'runtime.json')).toEqual({ api: 'http://127.0.0.1:43210/plugin/v1', installId: 'pi_1', state: 'pending' });
        // A different approved hash never promotes the local pending manifest.
        s.setInstalls([s.view('enabled', ['sidebar'], 'f'.repeat(64))]);
        await s.runtime.onInstallChanged('pi_1');
        expect(s.store.readToken('hello-board')).toBeNull();
        s.setInstalls([s.view('enabled', ['sidebar', 'bogus'], manifestHash(s.m))]);
        await s.runtime.onInstallChanged('pi_1');
        expect(s.ops.filter((o) => o[1] === 'install.sync').every((o) => o[0] === null)).toBe(true);
        expect(s.store.readToken('hello-board')).toMatch(/^vhp_/);
        expect(s.runtime.registry.get('hello-board')?.record.grants).toEqual(['sidebar']);
        expect(s.store.readFileJson('hello-board', 'runtime.json')).toMatchObject({ state: 'enabled' });
        // A notice for an unknown install does not even sync.
        const n = s.ops.length;
        await s.runtime.onInstallChanged('pi_unknown');
        expect(s.ops).toHaveLength(n);
        s.runtime.stop();
    });

    it('connect: install.sync, then queue replay in order (refusals dropped), then events; gone from the account → removed', async () => {
        const s = setup();
        s.setInstalls([s.view('enabled', ['sidebar', 'decisions'], manifestHash(s.m))]);
        await s.runtime.onConnected();
        const token = s.store.readToken('hello-board')!;
        s.setOnline(false);
        const call = (method: string, path: string, body: unknown) => s.runtime.handleApi({ method, path, query: {}, headers: { authorization: `Bearer ${token}` }, body });
        expect((await call('PUT', '/badge', { count: 1 })).status).toBe(503);
        await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' });
        s.ops.length = 0;
        s.setOnline(true);
        s.refuse.set('badge.put', 'permission_denied');
        await s.runtime.onConnected();
        await new Promise((r) => setTimeout(r, 0));
        expect(s.ops.map((o) => o[1])).toEqual(['install.sync', 'badge.put', 'decision.post', 'events.pull']);
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        // Persisted queue.
        s.setOnline(false);
        await call('PUT', '/badge', { count: 5 });
        expect(s.store.readFileJson('hello-board', 'queue.json')).toMatchObject([{ key: 'badge', payload: { count: 5 } }]);
        s.setOnline(true);
        s.setInstalls([]);
        await s.runtime.onConnected();
        expect(s.runtime.registry.get('hello-board')?.state).toBe('removed');
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        expect(await call('PUT', '/badge', { count: 1 })).toMatchObject({ status: 403, body: { error: 'plugin_disabled' } });
        s.runtime.stop();
    }, 30_000);

    it('server without plugins-v1: no sync, queued writes dropped, API answers server_too_old', async () => {
        const s = setup();
        s.setInstalls([s.view('enabled', ['sidebar'], manifestHash(s.m))]);
        await s.runtime.onConnected();
        const token = s.store.readToken('hello-board')!;
        s.setOnline(false);
        await s.runtime.handleApi({ method: 'PUT', path: '/badge', query: {}, headers: { authorization: `Bearer ${token}` }, body: { count: 1 } });
        expect(s.runtime.queue.size('pi_1')).toBe(1);
        s.setOnline(true);
        s.setSupport('no');
        s.ops.length = 0;
        await s.runtime.onConnected();
        expect(s.ops).toEqual([]);
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        expect(await s.runtime.handleApi({ method: 'PUT', path: '/badge', query: {}, headers: { authorization: `Bearer ${token}` }, body: { count: 1 } })).toMatchObject({ status: 503, body: { error: 'server_too_old' } });
        s.runtime.stop();
    });

    it('plugins_disabled from a plugins-v1 server (switch off for the account) = server_too_old: 503, queue dropped, nothing queued after', async () => {
        const s = setup();
        s.setInstalls([s.view('enabled', ['sidebar'], manifestHash(s.m))]);
        await s.runtime.onConnected();
        const token = s.store.readToken('hello-board')!;
        const put = () => s.runtime.handleApi({ method: 'PUT', path: '/badge', query: {}, headers: { authorization: `Bearer ${token}` }, body: { count: 1 } });
        s.setOnline(false);
        await put();
        expect(s.runtime.queue.size('pi_1')).toBe(1);
        s.setOnline(true);
        s.refuse.set('badge.put', 'plugins_disabled');
        s.refuse.set('install.sync', 'plugins_disabled');
        await s.runtime.onConnected();
        expect(s.runtime.serverSupport()).toBe('no');
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        expect(await put()).toMatchObject({ status: 503, body: { error: 'server_too_old' } });
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        s.runtime.stop();
    });

    it('panel RPCs only; no plugin-event RPC (r4)', () => {
        const s = setup();
        expect(Object.keys(pluginRpcHandlers(s.runtime)).sort()).toEqual(['plugin-http', 'plugin-http-body', 'plugin-http-pull']);
        s.runtime.stop();
    });

    it('install.sync items are parsed leniently but never invent states', () => {
        expect(parseInstallView({ id: 'a', pluginId: 'b', state: 'enabled', grants: ['sidebar', 'root'], manifest: null, manifestHash: null, pending: false })).toEqual({ installId: 'a', pluginId: 'b', state: 'enabled', grants: ['sidebar'], manifestHash: null });
        expect(parseInstallView({ id: 'a', pluginId: 'b', state: 'superuser', grants: [], manifest: null, manifestHash: null, pending: false })).toBeNull();
        expect(parseInstallView({ installId: 'a', pluginId: 'b', state: 'enabled', grants: [] })).toBeNull();
        expect(parseInstallView(null)).toBeNull();
    });

    it('local sessions: tracked sessions of this machine; messages are text only', async () => {
        const readLog = vi.fn(async () => [
            { seq: 10, body: { role: 'user', content: { type: 'text', text: 'hello' } }, createdAt: 5 },
            { seq: 11, body: { role: 'session', content: { role: 'agent', ev: { t: 'tool-call-start', name: 'Bash', args: { command: 'cat secret' } } } } },
            { seq: 12, body: { role: 'session', content: { role: 'agent', ev: { t: 'text', text: 'thinking…', thinking: true } } } },
            { seq: 13, body: { role: 'session', content: { role: 'agent', ev: { t: 'text', text: 'done' } } }, createdAt: 6 },
            { seq: 14, body: null },
        ]);
        const sessions = trackedPluginSessions({
            machineId: 'm1',
            isTurnActive: (id) => id === 's1',
            readLog,
            children: () => [
                { happySessionId: 's1', happySessionMetadataFromLocalWebhook: { path: '/w', name: 'n', flavor: 'claude', machineId: 'm1' } },
                { happySessionId: 's2', happySessionMetadataFromLocalWebhook: { machineId: 'other' } },
                { happySessionId: undefined },
            ],
        });
        expect(sessions.isLocal('s1')).toBe(true);
        expect(sessions.isLocal('s2')).toBe(false);
        // P3-10: no live reader and no update time → `updatedAt` is left out, not 0.
        expect(await sessions.list()).toEqual([{ id: 's1', title: 'n', cwd: '/w', agent: 'claude', status: 'running' }]);
        const page = await sessions.readMessages('s1', 20, '99');
        expect(readLog).toHaveBeenCalledWith('s1', 200, 99);
        expect(page.messages).toEqual([{ id: '10', role: 'user', text: 'hello', createdAt: 5 }, { id: '13', role: 'agent', text: 'done', createdAt: 6 }]);
        expect(messageFromLogEntry({ seq: 1, body: { role: 'agent', content: { type: 'acp', data: { type: 'tool-call', name: 'x' } } } })).toBeNull();
    });
});

describe('B-974h P3-10: sessions.list carries the real title and updatedAt, or leaves them out', () => {
    const children = () => [
        { happySessionId: 's1', happySessionMetadataFromLocalWebhook: { path: '/a', flavor: 'claude', machineId: 'm1' } },
        { happySessionId: 's2', happySessionMetadataFromLocalWebhook: { path: '/b', flavor: 'codex', machineId: 'm1', summary: { text: 'snapshot title', updatedAt: 5 } } },
        { happySessionId: 's3', happySessionMetadataFromLocalWebhook: { path: '/c', machineId: 'm1', name: '  ' } },
    ];
    const base = { machineId: 'm1', children, isTurnActive: () => false, readLog: async () => [] };

    it('live title / updatedAt win over the spawn-time snapshot; unknown fields are omitted (never null / 0)', async () => {
        const liveInfo = vi.fn(async (id: string) => id === 's1' ? { title: 'Fix the login bug', updatedAt: 1_800_000_000_000 } : id === 's2' ? {} : null);
        const list = await trackedPluginSessions({ ...base, liveInfo }).list();
        expect(list).toEqual([
            { id: 's1', title: 'Fix the login bug', cwd: '/a', agent: 'claude', status: 'idle', updatedAt: 1_800_000_000_000 },
            { id: 's2', title: 'snapshot title', cwd: '/b', agent: 'codex', status: 'idle', updatedAt: 5 },
            { id: 's3', cwd: '/c', agent: null, status: 'idle' },
        ]);
        for (const row of list) {
            expect(row).not.toHaveProperty('title', null);
            expect(Object.values(row)).not.toContain(0);
        }
    });

    it('a failing live read falls back to the last answer; answers are cached for the TTL', async () => {
        let t = 0;
        let fail = false;
        const liveInfo = vi.fn(async () => { if (fail) throw new Error('offline'); return { title: 'T', updatedAt: 9 }; });
        const sessions = trackedPluginSessions({ ...base, children: () => [children()[0]], liveInfo, liveTtlMs: 1_000, now: () => t });
        expect((await sessions.list())[0]).toMatchObject({ title: 'T', updatedAt: 9 });
        await sessions.list();
        expect(liveInfo).toHaveBeenCalledTimes(1);
        t = 2_000; fail = true;
        expect((await sessions.list())[0]).toMatchObject({ title: 'T', updatedAt: 9 });
        expect(liveInfo).toHaveBeenCalledTimes(2);
    });
});

describe('B-974h P3-9: the runtime learns install origins after install.sync', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    it('fetchOriginHosts runs after a successful sync and feeds the forwarder; a failure keeps the last map', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        const m = sampleManifest();
        store.writePending(m.id, m);
        store.writeInstall(m.id, { installId: 'pi_1', pluginId: m.id, state: 'pending', grants: [], approvedManifestHash: null, updatedAt: 1 });
        const installs = [{ id: 'pi_1', pluginId: 'hello-board', state: 'enabled', grants: ['panel'], manifest: null, manifestHash: manifestHash(m), pending: false }];
        let fail = false;
        const fetchOriginHosts = vi.fn(async () => { if (fail) throw new Error('down'); return new Map([['pi_1', 'hello-board-abcdefgh.p.example.test']]); });
        const runtime = new PluginRuntime({
            home: t.home, machineId: () => 'm1',
            serverOp: async (_i, op) => op === 'install.sync' ? { kind: 'ok', result: { installs } } : op === 'events.pull' ? { kind: 'ok', result: { events: [], cursor: null } } : { kind: 'ok', result: {} },
            sessions: { list: () => [], isLocal: () => false, readMessages: async () => ({ messages: [], cursor: null }) },
            probeServerSupport: async () => 'yes',
            fetchOriginHosts,
        });
        runtime.start(43211);
        await runtime.onConnected();
        expect(fetchOriginHosts).toHaveBeenCalledTimes(1);
        expect(runtime.originHostOf('pi_1')).toBe('hello-board-abcdefgh.p.example.test');
        fail = true;
        await runtime.onInstallChanged('pi_1');
        expect(runtime.originHostOf('pi_1')).toBe('hello-board-abcdefgh.p.example.test');
        runtime.stop();
    });
});
