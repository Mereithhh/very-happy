import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginRuntime, parseInstallView, pluginRpcHandlers, trackedPluginSessions } from './runtime';
import type { ServerOpResult } from './localApi';
import { manifestHash } from './manifest';
import { sampleManifest, tempHome } from './testFixtures';
import { PluginStore } from './store';

describe('B-974c runtime: install sync, approval, queue replay', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    function setup() {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        const m = sampleManifest();
        store.writePending(m.id, m);
        store.writeInstall(m.id, { installId: 'pi_1', pluginId: m.id, state: 'pending', grants: [], approvedManifestHash: null, updatedAt: 1 });
        let online = true;
        let installs: unknown[] = [];
        const ops: Array<[string | null, string, Record<string, unknown>]> = [];
        const serverOp = vi.fn(async (installId: string | null, op: string, payload: Record<string, unknown>): Promise<ServerOpResult> => {
            ops.push([installId, op, payload]);
            if (!online) return { kind: 'offline' };
            if (op === 'installs.sync') return { kind: 'ok', result: { installs } };
            if (op === 'events.pending') return { kind: 'ok', result: { events: [] } };
            return { kind: 'ok', result: {} };
        });
        const runtime = new PluginRuntime({ home: t.home, machineId: () => 'm1', serverOp, sessions: { list: () => [], isLocal: () => false } });
        runtime.start(43210);
        return { store, runtime, ops, m, setOnline: (v: boolean) => { online = v; }, setInstalls: (v: unknown[]) => { installs = v; } };
    }

    it('approval over RPC promotes the pending manifest, creates credentials and runtime.json', async () => {
        const s = setup();
        expect(s.store.readFileJson('hello-board', 'runtime.json')).toEqual({ api: 'http://127.0.0.1:43210/plugin/v1', installId: 'pi_1', state: 'pending' });
        const rpc = pluginRpcHandlers(s.runtime);
        expect(await rpc['plugin-install-changed']({ installId: 'pi_1', pluginId: 'hello-board', state: 'enabled', grants: ['sidebar', 'bogus'], manifestHash: manifestHash(s.m) })).toEqual({ applied: true });
        expect(s.store.readToken('hello-board')).toMatch(/^vhp_/);
        expect(s.runtime.registry.get('hello-board')?.record.grants).toEqual(['sidebar']);
        expect(s.store.readFileJson('hello-board', 'runtime.json')).toMatchObject({ state: 'enabled' });
        // Mismatched plugin id for a known install is refused.
        expect(await rpc['plugin-install-changed']({ installId: 'pi_1', pluginId: 'evil', state: 'enabled', grants: [], manifestHash: null })).toEqual({ error: 'unknown_install' });
        s.runtime.stop();
    });

    it('connect: sync applies server state, replays queued writes in order, fetches events; disabled → queue dropped', async () => {
        const s = setup();
        s.setInstalls([{ installId: 'pi_1', pluginId: 'hello-board', state: 'enabled', grants: ['sidebar', 'decisions'], manifestHash: manifestHash(s.m) }]);
        await s.runtime.onConnected();
        const token = s.store.readToken('hello-board')!;
        s.setOnline(false);
        const call = (method: string, path: string, body: unknown) => s.runtime.handleApi({ method, path, query: {}, headers: { authorization: `Bearer ${token}` }, body });
        expect((await call('PUT', '/badge', { count: 1 })).status).toBe(503);
        await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' });
        s.ops.length = 0;
        s.setOnline(true);
        await s.runtime.onConnected();
        expect(s.ops.map((o) => o[1])).toEqual(['installs.sync', 'badge.put', 'decision.post', 'events.pending']);
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        // Persisted queue survives a restart.
        s.setOnline(false);
        await call('PUT', '/badge', { count: 5 });
        expect(s.store.readFileJson('hello-board', 'queue.json')).toMatchObject([{ key: 'badge', payload: { count: 5 } }]);
        // Removed on the account side → disabled locally, queue cleared.
        s.setOnline(true);
        s.setInstalls([]);
        await s.runtime.onConnected();
        expect(s.runtime.registry.get('hello-board')?.state).toBe('disabled');
        expect(s.runtime.queue.size('pi_1')).toBe(0);
        s.runtime.stop();
    }, 30_000);

    it('install views are parsed leniently but never invent states', () => {
        expect(parseInstallView({ installId: 'a', pluginId: 'b', state: 'enabled', grants: ['sidebar', 'root'] })).toEqual({ installId: 'a', pluginId: 'b', state: 'enabled', grants: ['sidebar'], manifestHash: null });
        expect(parseInstallView({ installId: 'a', pluginId: 'b', state: 'superuser' })).toBeNull();
        expect(parseInstallView(null)).toBeNull();
    });

    it('local sessions: only tracked sessions of this machine', () => {
        const sessions = trackedPluginSessions({
            machineId: 'm1',
            isTurnActive: (id) => id === 's1',
            children: () => [
                { happySessionId: 's1', happySessionMetadataFromLocalWebhook: { path: '/w', name: 'n', flavor: 'claude', machineId: 'm1' } },
                { happySessionId: 's2', happySessionMetadataFromLocalWebhook: { machineId: 'other' } },
                { happySessionId: undefined },
            ],
        });
        expect(sessions.isLocal('s1')).toBe(true);
        expect(sessions.isLocal('s2')).toBe(false);
        expect(sessions.list()).toEqual([{ id: 's1', title: 'n', cwd: '/w', agent: 'claude', status: 'running', updatedAt: 0 }]);
    });
});
