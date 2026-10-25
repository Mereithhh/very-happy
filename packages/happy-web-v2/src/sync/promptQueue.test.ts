import { describe, expect, it } from 'vitest';
import { OUTBOX_AUTO_RESEND_MS } from './cache/outboxStore';
import { createPromptQueueStore, handOffRows, isRefusedStatus, PromptQueueHttpError, type PendingPromptPersistence, movedOrder, reloadPromptQueue, retryWaitingPrompts, supportsServerPromptQueue, type PromptQueueWireItem } from './promptQueue';

type Call = { path: string; method: string; body?: unknown };

function harness(opts?: {
    status?: number;
    items?: () => PromptQueueWireItem[];
    /** B-722: awaited before a POST/PATCH is answered — hold it open or make it throw. */
    gate?: (method: string) => Promise<void>;
    online?: () => boolean;
    /** B-804: awaited before a GET is answered (its answer is read when it starts). */
    getGate?: () => Promise<void>;
    inTranscript?: (sessionId: string, localId: string) => boolean;
    onDispatched?: (sessionId: string, localIds: string[]) => void;
    persist?: PendingPromptPersistence;
    now?: () => number;
    /** B-815: answers only writes with this status (GETs stay 200). */
    writeStatus?: () => number | null;
}) {
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
            if (opts?.gate && (method === 'POST' || method === 'PATCH')) await opts.gate(method);
            // Production's SPA fallback answers an unknown /v1 path with `{error:'Not found'}` (spaFallback.ts) — the exact body.
            const writeStatus = method !== 'GET' ? opts?.writeStatus?.() : null;
            if (writeStatus) return { status: writeStatus, json: async () => (writeStatus >= 500 ? (() => { throw new Error('html'); })() : { error: 'nope' }) };
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
            const answer = opts?.items ? opts.items() : items;
            if (opts?.getGate) await opts.getGate();
            return { status: 200, json: async () => ({ items: answer }) };
        },
        encrypt: async (_sessionId, text, modeMeta) => `enc:${text}|${JSON.stringify(modeMeta)}`,
        decrypt: async (_sessionId, encrypted) => {
            const raw = encrypted.replace(/^enc:/, '');
            if (raw === 'garbage') return null;
            const [text, meta] = raw.split('|');
            return { role: 'user', content: { type: 'text', text }, meta: meta ? JSON.parse(meta) : {} };
        },
        newLocalId: () => `local-${++nextId}`,
        isOnline: opts?.online,
        now: opts?.now ?? (() => 42),
        inTranscript: opts?.inTranscript,
        onDispatched: opts?.onDispatched,
        persist: opts?.persist,
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

describe('B-722 optimistic queue rows', () => {
    const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

    it('submit shows the row before the server answers; the snapshot replaces it in one update — never both, never neither', async () => {
        let release!: () => void;
        const h = harness({ gate: () => new Promise<void>((resolve) => { release = resolve; }) });
        const seen: Array<{ items: string[]; pending: string[] }> = [];
        h.store.subscribe((state) => {
            const s1 = state.sessions.s1;
            seen.push({ items: (s1?.items ?? []).map((item) => item.localId), pending: (s1?.pending ?? []).map((row) => row.localId) });
        });
        const result = h.store.getState().submit('s1', 'queued text', { effort: 'high' });
        // Synchronously visible, as `sending`.
        expect(h.store.getState().sessions.s1.pending).toEqual([{ localId: 'local-1', text: 'queued text', modeMeta: { effort: 'high' }, createdAt: 42, state: 'sending' }]);
        await flush();
        release();
        expect(await result).toBe('queued');
        expect(h.store.getState().sessions.s1.items.map((item) => item.localId)).toEqual(['local-1']);
        expect(h.store.getState().sessions.s1.pending).toBeUndefined();
        // Every intermediate state shows the prompt exactly once.
        for (const state of seen) expect([...state.items, ...state.pending].filter((id) => id === 'local-1')).toHaveLength(1);
    });

    it('a refusal marks the row failed (kept for Retry with its localId); offline it waits and goes out when the network is back', async () => {
        let fail: Error | null = new PromptQueueHttpError('prompt_queue_full');
        let online = true;
        const h = harness({ gate: async () => { if (fail) throw fail; }, online: () => online });
        await expect(h.store.getState().submit('s1', 'one', {})).rejects.toThrow('prompt_queue_full');
        expect(h.store.getState().sessions.s1.pending?.map((row) => [row.state, row.retryable])).toEqual([['failed', undefined]]);

        online = false;
        fail = new Error('network');
        await expect(h.store.getState().submit('s1', 'two', {})).rejects.toThrow('network');
        // B-815: unanswered while the app still thinks it is online — failed, but it goes out on its own.
        online = true;
        await expect(h.store.getState().submit('s1', 'three', {})).rejects.toThrow('network');
        expect(h.store.getState().sessions.s1.pending?.map((row) => [row.text, row.state, row.retryable])).toEqual([['one', 'failed', undefined], ['two', 'waiting', undefined], ['three', 'failed', true]]);

        // Back online: the waiting row and the unanswered one are retried automatically, with their own localIds; the refused one is not.
        fail = null;
        retryWaitingPrompts(h.store);
        await flush();
        await flush();
        expect(h.calls.filter((call) => call.method === 'POST').map((call) => (call.body as { localId: string }).localId)).toEqual(['local-1', 'local-2', 'local-3', 'local-2', 'local-3']);
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['two', 'three']);
        expect(h.store.getState().sessions.s1.pending?.map((row) => row.text)).toEqual(['one']);

        // Retry by hand: same localId (idempotent on the server).
        expect(await h.store.getState().retryPending('s1', 'local-1')).toBe('queued');
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['two', 'three', 'one']);
        expect(h.store.getState().sessions.s1.pending).toBeUndefined();
    });

    it('discard hands a failed row back (放回输入框 / 删除) and never drops one still sending', async () => {
        let release!: () => void;
        let fail = false;
        const h = harness({ gate: () => fail ? Promise.reject(new Error('x')) : new Promise<void>((resolve) => { release = resolve; }) });
        const sending = h.store.getState().submit('s1', 'in flight', {});
        expect(h.store.getState().discardPending('s1', 'local-1')).toBeNull();
        await flush();
        release();
        await sending;
        fail = true;
        await expect(h.store.getState().submit('s1', 'broken', {})).rejects.toThrow('x');
        expect(h.store.getState().discardPending('s1', 'local-2')?.text).toBe('broken');
        expect(h.store.getState().sessions.s1.pending).toBeUndefined();
    });

    it('an edit shows the new text at once and puts the old one back when the save fails', async () => {
        let fail = false;
        let release: (() => void) | null = null;
        const h = harness({ gate: (method) => method !== 'PATCH' ? Promise.resolve() : fail ? Promise.reject(new Error('offline')) : new Promise<void>((resolve) => { release = resolve; }) });
        await h.store.getState().enqueue('s1', 'before', {});
        const saving = h.store.getState().updateText('s1', 'id-local-1', 'after');
        expect(h.store.getState().sessions.s1.items[0].text).toBe('after');
        await flush();
        release!();
        expect(await saving).toBe(true);
        fail = true;
        await expect(h.store.getState().updateText('s1', 'id-local-1', 'lost')).rejects.toThrow('offline');
        expect(h.store.getState().sessions.s1.items[0].text).toBe('after');
    });
});

describe('B-804 dock hand-off and queue reload', () => {
    const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    it('an item the wrapper took stays as 「执行中」 until the transcript holds its localId — never in neither place', async () => {
        const transcript = new Set<string>();
        const verified: string[][] = [];
        const h = harness({ inTranscript: (_sid, localId) => transcript.has(localId), onDispatched: (_sid, ids) => verified.push(ids) });
        await h.store.getState().applySnapshot('s1', [h.wire('a', 'first', 1), h.wire('b', 'second', 2)], 1);
        // The wrapper dispatched `a`: the snapshot drops it, the transcript is still behind (dead GET).
        await h.store.getState().applySnapshot('s1', [h.wire('b', 'second', 1)], 2);
        let state = h.store.getState().sessions.s1;
        expect(state.items.map((item) => item.localId)).toEqual(['b']);
        expect(state.dispatched).toEqual([{ localId: 'a', text: 'first' }]);
        expect(verified).toEqual([['a']]);
        // Unrelated messages land: still not there, the row stays.
        h.store.getState().settleDispatched('s1');
        expect(h.store.getState().sessions.s1.dispatched).toHaveLength(1);
        // Its message reaches the transcript: the row goes in the same step.
        transcript.add('a');
        h.store.getState().settleDispatched('s1');
        state = h.store.getState().sessions.s1;
        expect(state.dispatched).toBeUndefined();
    });

    it('no hand-off row when the transcript already has it, or when this tab removed the item itself', async () => {
        const h = harness({ inTranscript: (_sid, localId) => localId === 'seen' });
        h.setItems([h.wire('seen', 'x', 1), h.wire('mine', 'y', 2)]);
        await h.store.getState().load('s1');
        await h.store.getState().remove('s1', 'id-mine');
        await h.store.getState().applySnapshot('s1', [], 5);
        expect(h.store.getState().sessions.s1.dispatched).toBeUndefined();
        expect(handOffRows([{ id: 'i', localId: 'l', position: 1, text: 't', modeMeta: {}, createdAt: 1 }], new Set(), new Set(), () => false)).toEqual([{ localId: 'l', text: 't' }]);
    });

    it('a row the transcript never gets (deleted elsewhere) goes once a fetch started after the hand-off verified it', async () => {
        const h = harness();
        await h.store.getState().applySnapshot('s1', [h.wire('a', 'first', 1)], 1);
        await h.store.getState().applySnapshot('s1', [], 2);
        expect(h.store.getState().sessions.s1.dispatched).toHaveLength(1);
        h.store.getState().settleDispatched('s1', ['other']);
        expect(h.store.getState().sessions.s1.dispatched).toHaveLength(1);
        h.store.getState().settleDispatched('s1', ['a']);
        expect(h.store.getState().sessions.s1.dispatched).toBeUndefined();
    });

    it('an older load answer never overwrites a newer socket snapshot', async () => {
        let release!: () => void;
        let hold = true;
        const h = harness({ getGate: () => hold ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve() });
        h.setItems([h.wire('a', 'old', 1)]);
        hold = false;
        await h.store.getState().load('s1');
        hold = true;
        // The GET reads the server while `a` is still queued…
        const loading = h.store.getState().load('s1');
        await flush();
        // …the wrapper dispatches `a` and enqueues nothing; the socket snapshot arrives first.
        await h.store.getState().applySnapshot('s1', [h.wire('b', 'new', 1)], 7);
        release();
        await loading;
        expect(h.store.getState().sessions.s1.items.map((item) => item.localId)).toEqual(['b']);
        // A load that started after the snapshot is applied as usual.
        hold = false;
        h.setItems([h.wire('c', 'later', 1)]);
        await h.store.getState().load('s1');
        expect(h.store.getState().sessions.s1.items.map((item) => item.localId)).toEqual(['c']);
    });

    it('reload (resume / reconnect) re-reads a mirrored queue, and leaves a never-loaded or unsupported one alone', async () => {
        const h = harness();
        await reloadPromptQueue('s1', h.store);
        expect(h.calls).toHaveLength(0);
        await h.store.getState().load('s1');
        h.setItems([h.wire('a', 'x', 1)]);
        await reloadPromptQueue('s1', h.store);
        expect(h.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
        expect(h.store.getState().sessions.s1.items).toHaveLength(1);
        const old = harness({ status: 404 });
        await old.store.getState().load('s1');
        await reloadPromptQueue('s1', old.store);
        expect(old.calls).toHaveLength(1);
    });
});

describe('B-815 unaccepted rows in the persistent outbox', () => {
    function recorder() {
        const log: string[] = [];
        const persist: PendingPromptPersistence = {
            save: async (_sid, row, retried) => { log.push(`save ${row.localId} ${row.content} ${retried ? 'retry' : 'keep-clock'}`); },
            fail: (ids) => { log.push(`fail ${ids.join(',')}`); },
            forget: (ids) => { log.push(`forget ${ids.join(',')}`); },
        };
        return { log, persist };
    }

    it('saved before the POST, forgotten once the server lists it; a retry re-POSTs the same bytes and restarts the clock', async () => {
        const { log, persist } = recorder();
        let fail: Error | null = new Error('down');
        const h = harness({ persist, gate: async (method) => { log.push(method); if (fail) throw fail; } });
        await h.store.getState().submit('s1', 'hello', {}).catch(() => {});
        // Unanswered: stays queued on disk (re-sent by whoever holds it).
        expect(log).toEqual(['save local-1 enc:hello|{} keep-clock', 'POST']);
        fail = new PromptQueueHttpError('prompt_queue_full');
        log.length = 0;
        await h.store.getState().retryPending('s1', 'local-1').catch(() => {});
        // Refused: failed on disk — only the user re-sends it.
        expect(log).toEqual(['save local-1 enc:hello|{} retry', 'POST', 'fail local-1']);
        fail = null;
        log.length = 0;
        await h.store.getState().retryPending('s1', 'local-1');
        expect(log).toEqual(['save local-1 enc:hello|{} retry', 'POST', 'forget local-1', 'forget local-1']);
        expect(h.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { content: string }).content)).toEqual(['enc:hello|{}', 'enc:hello|{}', 'enc:hello|{}']);
    });

    it('offline it waits — never marked failed on disk (whoever holds it re-sends it); the automatic retry keeps the clock', async () => {
        const { log, persist } = recorder();
        let online = false;
        const h = harness({ persist, online: () => online, gate: async () => { if (!online) throw new Error('offline'); } });
        await h.store.getState().submit('s1', 'later', {}).catch(() => {});
        expect(log).toEqual(['save local-1 enc:later|{} keep-clock']);
        online = true;
        log.length = 0;
        retryWaitingPrompts(h.store);
        await new Promise((r) => setTimeout(r, 0));
        expect(log[0]).toBe('save local-1 enc:later|{} keep-clock');
    });

    it('an old server (unsupported): a submitted row is forgotten (the tab-local queue owns it); an adopted one waits failed for the user', async () => {
        const { log, persist } = recorder();
        const h = harness({ persist, status: 404 });
        expect(await h.store.getState().submit('s1', 'old', {})).toBe('unsupported');
        expect(log).toEqual(['save local-1 enc:old|{} keep-clock', 'forget local-1']);
        log.length = 0;
        h.store.getState().adoptPending('s1', [{ localId: 'adopted', text: 'kept', modeMeta: {}, createdAt: 1, content: 'enc:kept|{}', stale: false }]);
        await new Promise((r) => setTimeout(r, 0));
        expect(log).toEqual(['fail adopted']);
        expect(h.store.getState().sessions.s1.pending).toMatchObject([{ localId: 'adopted', state: 'failed' }]);
    });

    it('adoptPending: fresh rows are enqueued with their own localId and bytes, stale ones wait failed, held localIds are skipped', async () => {
        const h = harness();
        h.setItems([h.wire('on-server', 'queued', 1)]);
        await h.store.getState().load('s1');
        h.store.getState().adoptPending('s1', [
            { localId: 'fresh', text: 'fresh', modeMeta: {}, createdAt: 1, content: 'enc:fresh', stale: false },
            { localId: 'old', text: 'old', modeMeta: {}, createdAt: 2, content: 'enc:old', stale: true },
            { localId: 'on-server', text: 'queued', modeMeta: {}, createdAt: 3, content: 'enc:queued', stale: false },
        ]);
        await new Promise((r) => setTimeout(r, 0));
        expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ localId: 'fresh', content: 'enc:fresh' }]);
        expect(h.store.getState().sessions.s1.pending).toEqual([{ localId: 'old', text: 'old', modeMeta: {}, createdAt: 2, content: 'enc:old', state: 'failed' }]);
    });

    const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

    it('a gateway 5xx (deploy) is unanswered, not refused: retryable, queued on disk; 4xx and our own codes are refused', async () => {
        expect([502, 503, 504, 500].map((status) => isRefusedStatus(status, null))).toEqual([false, false, false, false]);
        expect(isRefusedStatus(503, 'prompt_queue_full')).toBe(true);
        expect(isRefusedStatus(409, 'prompt_queue_full')).toBe(true);
        expect(isRefusedStatus(400, null)).toBe(true);
        const { log, persist } = recorder();
        let status: number | null = 502;
        const h = harness({ persist, writeStatus: () => status });
        await expect(h.store.getState().submit('s1', 'deploying', {})).rejects.toThrow('HTTP 502');
        expect(h.store.getState().sessions.s1.pending).toMatchObject([{ state: 'failed', retryable: true }]);
        expect(log).toEqual(['save local-1 enc:deploying|{} keep-clock']);
        status = null;
        retryWaitingPrompts(h.store);
        await flush();
        await flush();
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['deploying']);
        expect(h.store.getState().sessions.s1.pending).toBeUndefined();
        status = 409;
        await expect(h.store.getState().submit('s1', 'refused', {})).rejects.toThrow(PromptQueueHttpError);
        expect(h.store.getState().sessions.s1.pending).toMatchObject([{ text: 'refused', state: 'failed' }]);
        expect(h.store.getState().sessions.s1.pending![0].retryable).toBeUndefined();
    });

    it('the in-page automatic retry keeps the takeover\'s 10 minutes: older rows wait failed (「未加入队列 · 重试」) and only the user re-sends them', async () => {
        const { log, persist } = recorder();
        let clock = 1_000;
        let online = false;
        let down = true;
        const h = harness({ persist, now: () => clock, online: () => online, gate: async () => { if (down) throw new Error('offline'); } });
        await h.store.getState().submit('s1', 'waited', {}).catch(() => {});
        online = true;
        await h.store.getState().submit('s1', 'on the way', {}).catch(() => {});
        down = false;
        expect(h.store.getState().sessions.s1.pending?.map((row) => [row.state, row.retryable])).toEqual([['waiting', undefined], ['failed', true]]);
        clock += OUTBOX_AUTO_RESEND_MS + 1;
        online = true;
        log.length = 0;
        const before = h.calls.length;
        retryWaitingPrompts(h.store);
        await flush();
        expect(h.calls.length).toBe(before);
        expect(h.store.getState().sessions.s1.pending?.map((row) => [row.text, row.state, row.retryable])).toEqual([['waited', 'failed', undefined], ['on the way', 'failed', undefined]]);
        expect(log).toEqual(['fail local-1', 'fail local-2']);
        // Not retryable any more: the next reconnect leaves them alone.
        retryWaitingPrompts(h.store);
        await flush();
        expect(h.calls.length).toBe(before);
        // The user's Retry sends it and restarts the clock in memory too.
        expect(await h.store.getState().retryPending('s1', 'local-1')).toBe('queued');
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['waited']);
        online = false;
        down = true;
        await h.store.getState().retryPending('s1', 'local-2').catch(() => {});
        expect(h.store.getState().sessions.s1.pending).toMatchObject([{ localId: 'local-2', state: 'waiting', createdAt: clock }]);
    });

    it('auto retry at exactly 10 minutes still goes out (same edge as takeoverAction)', async () => {
        let clock = 0;
        let online = false;
        const h = harness({ now: () => clock, online: () => online, gate: async () => { if (!online) throw new Error('offline'); } });
        await h.store.getState().submit('s1', 'edge', {}).catch(() => {});
        clock = OUTBOX_AUTO_RESEND_MS;
        online = true;
        retryWaitingPrompts(h.store);
        await flush();
        await flush();
        expect(h.store.getState().sessions.s1.items.map((item) => item.text)).toEqual(['edge']);
    });

    it('the server stopped queueing (unsupported): a retried or automatically retried row stays in the dock failed — never dropped', async () => {
        const { log, persist } = recorder();
        let status: number | null = null;
        let online = false;
        const h = harness({ persist, online: () => online, gate: async () => { if (!online) throw new Error('offline'); }, writeStatus: () => status });
        await h.store.getState().submit('s1', 'kept', {}).catch(() => {});
        await h.store.getState().submit('s1', 'kept too', {}).catch(() => {});
        online = true;
        // The POST itself answers the old server's 404 (status flips to unsupported).
        status = 404;
        log.length = 0;
        await expect(h.store.getState().retryPending('s1', 'local-1', true)).rejects.toThrow('prompt queue unsupported');
        expect(h.store.getState().sessions.s1.status).toBe('unsupported');
        // Already unsupported: the early branch keeps it too (the user's Retry and the automatic one).
        await expect(h.store.getState().retryPending('s1', 'local-2')).rejects.toThrow('prompt queue unsupported');
        expect(h.store.getState().sessions.s1.pending?.map((row) => [row.text, row.state])).toEqual([['kept', 'failed'], ['kept too', 'failed']]);
        expect(log.filter((entry) => entry.startsWith('forget'))).toEqual([]);
        expect(log.filter((entry) => entry.startsWith('fail'))).toEqual(['fail local-1', 'fail local-2']);
    });
});
