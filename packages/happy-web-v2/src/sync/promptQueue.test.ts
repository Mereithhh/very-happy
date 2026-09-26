import { describe, expect, it } from 'vitest';
import { createPromptQueueStore, movedOrder, supportsServerPromptQueue, type PromptQueueWireItem } from './promptQueue';

type Call = { path: string; method: string; body?: unknown };

function harness(opts?: { status?: number; items?: () => PromptQueueWireItem[] }) {
    const calls: Call[] = [];
    let items: PromptQueueWireItem[] = [];
    let nextId = 0;
    const wire = (localId: string, text: string, position: number): PromptQueueWireItem => ({
        id: `id-${localId}`, localId, position, content: { t: 'encrypted', c: `enc:${text}` }, createdAt: position, updatedAt: position,
    });
    const store = createPromptQueueStore({
        request: async (path, init) => {
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(init.body) : undefined;
            calls.push({ path, method, body });
            // Production's SPA fallback answers an unknown /v1 path with `{error:'Not found'}` (spaFallback.ts) — the exact body.
            if (opts?.status) return { status: opts.status, json: async () => ({ error: opts.status === 404 ? 'Not found' : 'nope' }) };
            if (method === 'POST' && path.endsWith('/prompt-queue')) {
                items = [...items, wire(body.localId, String(body.content).replace(/^enc:/, ''), items.length + 1)];
                return { status: 200, json: async () => ({ item: items[items.length - 1], items }) };
            }
            if (method === 'DELETE') {
                const before = items.length;
                items = items.filter((item) => !path.endsWith(`/${item.id}`));
                return { status: 200, json: async () => ({ removed: items.length < before, items }) };
            }
            if (method === 'PUT') {
                const order: string[] = body.ids;
                items = [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((item, index) => ({ ...item, position: index + 1 }));
                return { status: 200, json: async () => ({ items }) };
            }
            if (method === 'PATCH') {
                const id = path.split('/').pop();
                if (!items.some((item) => item.id === id)) return { status: 404, json: async () => ({ error: 'prompt_queue_item_gone' }) };
                items = items.map((item) => item.id === id ? { ...item, content: { t: 'encrypted', c: body.content } } : item);
                return { status: 200, json: async () => ({ items }) };
            }
            return { status: 200, json: async () => ({ items: opts?.items ? opts.items() : items }) };
        },
        encrypt: async (_sessionId, text, modeMeta) => `enc:${text}|${JSON.stringify(modeMeta)}`,
        decrypt: async (_sessionId, encrypted) => {
            const raw = encrypted.replace(/^enc:/, '');
            if (raw === 'garbage') return null;
            const [text, meta] = raw.split('|');
            return { role: 'user', content: { type: 'text', text }, meta: meta ? JSON.parse(meta) : {} };
        },
        newLocalId: () => `local-${++nextId}`,
    });
    return { store, calls, setItems: (next: PromptQueueWireItem[]) => { items = next; }, wire };
}

describe('B-509 prompt queue store', () => {
    it('gates on the wrapper capability, never on a version', () => {
        expect(supportsServerPromptQueue({ capabilities: ['prompt-queue-v1'] })).toBe(true);
        expect(supportsServerPromptQueue({ capabilities: ['claude-steer-v1'] })).toBe(false);
        expect(supportsServerPromptQueue(null)).toBe(false);
    });

    it('enqueue stores the encrypted user record with a fresh localId and mirrors the server snapshot', async () => {
        const h = harness();
        expect(await h.store.getState().enqueue('s1', 'first', { model: null })).toBe('queued');
        expect(await h.store.getState().enqueue('s1', 'second', { effort: 'high' })).toBe('queued');
        expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /v1/sessions/s1/prompt-queue', 'POST /v1/sessions/s1/prompt-queue']);
        expect(h.calls[0].body).toEqual({ localId: 'local-1', content: 'enc:first|{"model":null}' });
        const state = h.store.getState().sessions.s1;
        expect(state.status).toBe('ready');
        expect(state.items.map((item) => [item.text, item.modeMeta])).toEqual([['first', { model: null }], ['second', { effort: 'high' }]]);
    });

    it('a bare 404 (old server: route missing) marks the session unsupported so the composer falls back to the tab-local queue, and stays there', async () => {
        const h = harness({ status: 404 });
        expect(await h.store.getState().enqueue('s1', 'x', {})).toBe('unsupported');
        expect(h.store.getState().sessions.s1.status).toBe('unsupported');
        expect(await h.store.getState().enqueue('s1', 'y', {})).toBe('unsupported');
        await h.store.getState().load('s1');
        // Nothing else was tried once unsupported; a later snapshot does not resurrect it.
        expect(h.calls).toHaveLength(1);
        await h.store.getState().applySnapshot('s1', [h.wire('l', 'late', 1)]);
        expect(h.store.getState().sessions.s1.status).toBe('unsupported');
    });

    it('a 404 carrying one of OUR codes (item gone / session gone) is an ordinary error, never a fallback', async () => {
        const { isPromptQueueErrorCode } = await import('./promptQueue');
        expect(isPromptQueueErrorCode('prompt_queue_item_gone')).toBe(true);
        expect(isPromptQueueErrorCode('session_not_found')).toBe(true);
        expect(isPromptQueueErrorCode('Not found')).toBe(false);
        expect(isPromptQueueErrorCode('Not Found')).toBe(false);
        expect(isPromptQueueErrorCode(null)).toBe(false);
        const h = harness();
        await h.store.getState().enqueue('s1', 'a', {});
        h.setItems([]);
        expect(await h.store.getState().updateText('s1', 'id-local-1', 'x')).toBe(false); // PATCH → 404 prompt_queue_item_gone
        expect(h.store.getState().sessions.s1.status).toBe('ready');
    });

    it('other server errors surface as the server\'s error code', async () => {
        const h = harness({ status: 409 });
        await expect(h.store.getState().enqueue('s1', 'x', {})).rejects.toThrow('nope');
    });

    it('snapshots are ordered by position and an unreadable item keeps its slot instead of vanishing', async () => {
        const h = harness();
        await h.store.getState().applySnapshot('s1', [h.wire('b', 'second', 2), h.wire('a', 'first', 1), h.wire('c', 'garbage', 3)]);
        const items = h.store.getState().sessions.s1.items;
        expect(items.map((item) => item.text)).toEqual(['first', 'second', '']);
        expect(items.map((item) => item.localId)).toEqual(['a', 'b', 'c']);
        // Equal positions (a reorder that raced an enqueue) fall back to creation time.
        await h.store.getState().applySnapshot('s1', [{ ...h.wire('y', 'younger', 1), createdAt: 20 }, { ...h.wire('x', 'older', 1), createdAt: 10 }]);
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['older', 'younger']);
    });

    it('move sends the full new order (pure movedOrder) and remove reports whether the server still had it', async () => {
        const h = harness();
        await h.store.getState().enqueue('s1', 'a', {});
        await h.store.getState().enqueue('s1', 'b', {});
        await h.store.getState().enqueue('s1', 'c', {});
        await h.store.getState().move('s1', 'id-local-3', -1);
        expect(h.calls.at(-1)).toEqual({ path: '/v1/sessions/s1/prompt-queue/order', method: 'PUT', body: { ids: ['id-local-1', 'id-local-3', 'id-local-2'] } });
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['a', 'c', 'b']);
        const before = h.calls.length;
        await h.store.getState().move('s1', 'id-local-1', -1);
        expect(h.calls).toHaveLength(before); // head cannot move up: no request
        expect(await h.store.getState().remove('s1', 'id-local-3')).toBe(true);
        expect(await h.store.getState().remove('s1', 'id-local-3')).toBe(false);
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['a', 'b']);
        expect(movedOrder(['x', 'y'], 'y', 1)).toEqual(['x', 'y']);
        expect(movedOrder(['x', 'y'], 'y', -1)).toEqual(['y', 'x']);
    });

    it('editing re-encrypts with the item\'s own mode meta; an item the wrapper already popped reloads and reports false', async () => {
        const h = harness();
        await h.store.getState().enqueue('s1', 'draft', { permissionMode: 'plan' });
        expect(await h.store.getState().updateText('s1', 'id-local-1', 'final')).toBe(true);
        expect(h.calls.at(-1)).toEqual({ path: '/v1/sessions/s1/prompt-queue/id-local-1', method: 'PATCH', body: { content: 'enc:final|{"permissionMode":"plan"}' } });
        expect(h.store.getState().sessions.s1.items[0].text).toBe('final');
        h.setItems([]);
        expect(await h.store.getState().updateText('s1', 'id-local-1', 'again')).toBe(false);
        expect(h.store.getState().sessions.s1.items).toEqual([]);
    });

    it('an out-of-order socket snapshot (lower seq) is dropped; GET/mutation results are always applied', async () => {
        const h = harness();
        await h.store.getState().applySnapshot('s1', [h.wire('a', 'a', 1)], 10);
        await h.store.getState().applySnapshot('s1', [], 9);
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['a']);
        await h.store.getState().applySnapshot('s1', [], 11);
        expect(h.store.getState().sessions.s1.items).toEqual([]);
        await h.store.getState().applySnapshot('s1', [h.wire('b', 'b', 1)]); // no seq: legacy / GET path
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['b']);
    });

    it('enqueue with a caller-supplied localId is idempotent on the server (second tab migrating the same legacy item)', async () => {
        const h = harness();
        await h.store.getState().enqueue('s1', 'legacy', {}, 'legacy-id');
        await h.store.getState().enqueue('s1', 'legacy', {}, 'legacy-id');
        expect(h.calls.filter((call) => call.method === 'POST').map((call) => (call.body as { localId: string }).localId)).toEqual(['legacy-id', 'legacy-id']);
    });
});
