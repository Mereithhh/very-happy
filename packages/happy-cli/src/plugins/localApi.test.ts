import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginApi, type ServerOpResult, type LocalSessionInfo, type ServerPluginSupport } from './localApi';
import { OfflineQueue } from './offlineQueue';
import { PluginEventHub } from './events';
import { assertWirePluginOp, installApproved, registryFor, sampleManifest, tempHome } from './testFixtures';
import type { PluginPermission } from './manifest';
import type { PluginStore } from './store';
import type { PluginRegistry } from './registry';

describe('B-974c /plugin/v1 (DESIGN §5)', () => {
    let cleanup = () => {};
    let store: PluginStore;
    let registry: PluginRegistry;
    let token: string;
    let serverOp: ReturnType<typeof vi.fn>;
    let queue: OfflineQueue;
    let api: PluginApi;
    let online = true;
    let support: ServerPluginSupport = 'yes';
    let auditOk = true;
    const readMessages = vi.fn(async () => ({ messages: [{ id: '7', role: 'user' as const, text: 'hi', createdAt: 1 }], cursor: null }));
    const sessions: LocalSessionInfo[] = [
        { id: 's-local', title: 'A', cwd: '/w', agent: 'claude', status: 'idle', updatedAt: 2 },
        { id: 's-local2', title: 'B', cwd: '/w2', agent: 'codex', status: 'running', updatedAt: 3 },
    ];

    function setup(grants?: PluginPermission[], manifestOverrides = {}) {
        const t = tempHome(); cleanup = t.cleanup;
        ({ store, registry } = registryFor(t.home));
        const m = sampleManifest({ permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.list', 'sessions.read'], ...manifestOverrides });
        ({ token } = installApproved(store, m, { grants }));
        registry.reload();
        queue = new OfflineQueue();
        serverOp = vi.fn(async (_i: string | null, op: string, payload: Record<string, unknown>, requestId: string): Promise<ServerOpResult> => {
            assertWirePluginOp(_i, op, payload, requestId);
            if (!online) return { kind: 'offline' };
            if (op === 'decision.post') return { kind: 'ok', result: { item: { key: payload.key }, created: true } };
            if (op === 'audit.sensitiveRead') return auditOk ? { kind: 'ok', result: {} } : { kind: 'error', status: 403, error: 'permission_denied' };
            return { kind: 'ok', result: { ok: true, op } };
        });
        api = new PluginApi({ registry, queue, events: new PluginEventHub({ registry, serverOp }), serverOp, sessions: { list: () => sessions, isLocal: (id) => sessions.some((s) => s.id === id), readMessages }, machineId: () => 'm1', serverSupport: () => support });
    }
    const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}, query: Record<string, string> = {}) =>
        api.handle({ method, path, query, headers: { authorization: `Bearer ${token}`, ...extra }, body });

    beforeEach(() => { online = true; support = 'yes'; auditOk = true; readMessages.mockClear(); });
    afterEach(() => cleanup());

    it('401 without the plugin token; the token decides the install, not the body', async () => {
        setup();
        expect((await api.handle({ method: 'GET', path: '/info', query: {}, headers: {}, body: undefined })).status).toBe(401);
        expect((await api.handle({ method: 'GET', path: '/info', query: {}, headers: { authorization: 'Bearer vhp_wrong' }, body: undefined })).status).toBe(401);
        const info = await call('GET', '/info');
        expect(info).toMatchObject({ status: 200, body: { apiVersion: 1, installId: 'pi_hello-board', pluginId: 'hello-board', state: 'enabled', machineId: 'm1' } });
        await call('PUT', '/badge', { count: 3 });
        expect(serverOp).toHaveBeenCalledWith('pi_hello-board', 'badge.put', { count: 3 }, expect.any(String));
    });

    it('permission is checked per call against the current grants', async () => {
        setup(['decisions']);
        expect(await call('PUT', '/badge', { count: 1 })).toMatchObject({ status: 403, body: { error: 'permission_denied', permission: 'sidebar' } });
        expect((await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' })).status).toBe(201);
        // Needs panel for panelPath, session.widget|sessions.list for sessionId.
        expect(await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't', panelPath: '/x' })).toMatchObject({ status: 403, body: { permission: 'panel' } });
        expect(await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't', sessionId: 's-local' })).toMatchObject({ status: 403 });
        expect(await call('PUT', '/sessions/s-local/widget', { status: { label: 'x', tone: 'info' } })).toMatchObject({ status: 403, body: { permission: 'session.widget' } });
        expect(await call('GET', '/sessions')).toMatchObject({ status: 403, body: { permission: 'sessions.list' } });
        expect(await call('GET', '/sessions/s-local/messages')).toMatchObject({ status: 403, body: { permission: 'sessions.read' } });
        // Revoking decisions takes effect at the next call.
        store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, grants: [] });
        registry.reload();
        expect(await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' })).toMatchObject({ status: 403, body: { permission: 'decisions' } });
    });

    it('disabled install: every API refused, info still answers', async () => {
        setup();
        store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, localDisabled: true });
        registry.reload();
        expect(await call('PUT', '/badge', { count: 1 })).toMatchObject({ status: 403, body: { error: 'plugin_disabled' } });
        expect(await call('GET', '/events')).toMatchObject({ status: 403, body: { error: 'plugin_disabled' } });
        expect(await call('GET', '/info')).toMatchObject({ status: 200, body: { state: 'disabled', grants: [] } });
        expect(serverOp).not.toHaveBeenCalled();
    });

    it('validates bodies (400 invalid_request with issues)', async () => {
        setup();
        expect(await call('PUT', '/badge', { count: 10000 })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
        expect(await call('POST', '/decisions', { key: 'k', kind: 'choice', title: 't', options: [{ id: 'a', label: 'A' }] })).toMatchObject({ status: 400 });
        expect(await call('POST', '/decisions', { key: 'k', kind: 'input', title: 't' })).toMatchObject({ status: 400 });
        expect((await call('POST', '/decisions', { key: 'k', kind: 'input', title: 't', input: { maxLength: 100 } })).status).toBe(201);
        expect(await call('PUT', '/sessions/s-local/widget', { status: { label: 'x', tone: 'info' }, actions: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }] })).toMatchObject({ status: 400 });
        expect(await call('GET', '/nope')).toMatchObject({ status: 404 });
    });

    it('widgets and decisions only for sessions on this machine', async () => {
        setup();
        expect(await call('PUT', '/sessions/s-remote/widget', { status: { label: 'x', tone: 'info' } })).toMatchObject({ status: 403, body: { error: 'session_not_on_machine' } });
        expect(await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't', sessionId: 's-remote' })).toMatchObject({ status: 403, body: { error: 'session_not_on_machine' } });
        expect(await call('GET', '/sessions/s-remote/messages')).toMatchObject({ status: 403, body: { error: 'session_not_on_machine' } });
        expect((await call('PUT', '/sessions/s-local/widget', { status: { label: 'x', tone: 'info' } })).status).toBe(200);
        expect(serverOp).toHaveBeenLastCalledWith('pi_hello-board', 'widget.put', { sessionId: 's-local', status: { label: 'x', tone: 'info' } }, expect.any(String));
    });

    it('sensitive reads: audit.sensitiveRead first; offline or refused audit → 503 with no data; content read locally', async () => {
        setup();
        const r = await call('GET', '/sessions', undefined, {}, { limit: '1' });
        expect(r).toMatchObject({ status: 200, body: { sessions: [{ id: 's-local2' }], cursor: '1' } });
        expect(serverOp).toHaveBeenCalledWith('pi_hello-board', 'audit.sensitiveRead', { permission: 'sessions.list', sessionIds: ['s-local2'] }, expect.any(String));
        const m = await call('GET', '/sessions/s-local/messages', undefined, {}, { limit: '5', before: '40' });
        expect(m).toMatchObject({ status: 200, body: { messages: [{ id: '7', text: 'hi' }] } });
        expect(serverOp).toHaveBeenCalledWith('pi_hello-board', 'audit.sensitiveRead', { permission: 'sessions.read', sessionIds: ['s-local'] }, expect.any(String));
        expect(readMessages).toHaveBeenCalledWith('s-local', 5, '40');
        // The message content is never sent to the server.
        expect(serverOp.mock.calls.every((c) => !JSON.stringify(c[2]).includes('hi'))).toBe(true);
        readMessages.mockClear();
        auditOk = false;
        expect(await call('GET', '/sessions')).toMatchObject({ status: 503, body: { queued: false } });
        expect(await call('GET', '/sessions/s-local/messages')).toMatchObject({ status: 503, body: { queued: false } });
        expect(readMessages).not.toHaveBeenCalled();
        auditOk = true;
        online = false;
        const off = await call('GET', '/sessions');
        expect(off).toMatchObject({ status: 503, body: { error: 'server_unreachable', queued: false } });
        expect(off.body.sessions).toBeUndefined();
        expect(await call('GET', '/sessions/s-local/messages')).toMatchObject({ status: 503, body: { queued: false } });
        expect(readMessages).not.toHaveBeenCalled();
    });

    it('server without plugins-v1: every call 503 server_too_old, nothing queued', async () => {
        setup();
        support = 'no';
        expect(await call('PUT', '/badge', { count: 1 })).toMatchObject({ status: 503, body: { error: 'server_too_old', queued: false } });
        expect(await call('GET', '/info')).toMatchObject({ status: 503, body: { error: 'server_too_old' } });
        expect(queue.size('pi_hello-board')).toBe(0);
        expect(serverOp).not.toHaveBeenCalled();
        // Unknown (not asked yet) still queues while offline.
        support = 'unknown';
        online = false;
        expect(await call('PUT', '/badge', { count: 1 })).toMatchObject({ status: 503, body: { queued: true } });
    });

    it('events: pull forwards to events.pull, ack forwards to events.ack', async () => {
        setup();
        expect(await call('GET', '/events', undefined, {}, { after: 'c1' })).toMatchObject({ status: 200, body: { events: [] } });
        expect(serverOp).toHaveBeenCalledWith('pi_hello-board', 'events.pull', { after: 'c1', limit: 100 }, expect.any(String));
        expect((await call('POST', '/events/ack', { upTo: 'c9' })).status).toBe(200);
        expect(serverOp).toHaveBeenLastCalledWith('pi_hello-board', 'events.ack', { upTo: 'c9' }, expect.any(String));
    });

    it('offline writes are queued (503 queued:true) and newest-per-key', async () => {
        setup();
        online = false;
        expect(await call('PUT', '/badge', { count: 1 })).toMatchObject({ status: 503, body: { error: 'server_unreachable', queued: true } });
        await call('PUT', '/badge', { count: 2 });
        await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' });
        await call('DELETE', '/decisions/k', {});
        expect(queue.items('pi_hello-board').map((i) => [i.op, i.payload])).toEqual([['badge.put', { count: 2 }], ['decision.delete', { key: 'k' }]]);
        // Reads are not queued.
        expect(await call('GET', '/decisions')).toMatchObject({ status: 503, body: { queued: false } });
        // Back online: a key still queued stays behind the queue (ordering).
        online = true;
        expect(await call('PUT', '/badge', { count: 3 })).toMatchObject({ status: 503, body: { queued: true } });
        expect(queue.items('pi_hello-board').find((i) => i.key === 'badge')?.payload).toEqual({ count: 3 });
    });

    it('Idempotency-Key replays the first answer and refuses a different body', async () => {
        setup();
        const first = await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' }, { 'idempotency-key': 'abc' });
        const again = await call('POST', '/decisions', { title: 't', kind: 'notice', key: 'k' }, { 'idempotency-key': 'abc' });
        expect(again).toEqual(first);
        expect(serverOp.mock.calls.filter((c) => c[1] === 'decision.post')).toHaveLength(1);
        expect(await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 'other' }, { 'idempotency-key': 'abc' })).toMatchObject({ status: 422 });
        expect(await call('POST', '/decisions', { key: 'k', kind: 'notice', title: 't' }, { 'idempotency-key': 'x'.repeat(129) })).toMatchObject({ status: 400 });
    });
});
