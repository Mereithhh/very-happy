import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BUILTIN_TODO_PREFIX, MAX_COUNT, NOTE_MAX_LENGTH, TITLE_MAX_LENGTH,
    createBuiltinTodoClient as createClient, decodeBuiltinTodo, encodeBuiltinTodo, parseBuiltinTodo, sortBuiltinTodos,
    type BuiltinTodoRecord,
} from './builtinTodos';
type AuthCredentials = { token: string };
const createBuiltinTodoClient = (credentials: AuthCredentials, options: Partial<import('./builtinTodos').BuiltinTodoClientOptions> = {}) => createClient(credentials, { serverUrl: 'https://example.test', clientId: 'test-client', ...options });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const item = (n: number, patch: Partial<BuiltinTodoRecord> = {}): BuiltinTodoRecord => ({
    schemaVersion: 1, id: id(n), title: `Task ${n}`, note: '', status: 'open', order: n * 1024,
    createdAt: 100, updatedAt: 100, version: 0, ...patch,
});
const credentials = (token = 'account-a') => ({ token } as AuthCredentials);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Realistic CAS fake: account isolation, tombstones, and all-or-nothing batches. */
function server(initial: BuiltinTodoRecord[] = []) {
    const accounts = new Map<string, Map<string, { value: string | null; version: number }>>();
    const rows = (account: string) => {
        if (!accounts.has(account)) accounts.set(account, new Map());
        return accounts.get(account)!;
    };
    for (const record of initial) rows('account-a').set(BUILTIN_TODO_PREFIX + record.id, { value: encodeBuiltinTodo(record), version: record.version });
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
        const token = new Headers(options?.headers).get('Authorization')!.replace('Bearer ', '');
        const data = rows(token);
        const pathname = new URL(_url as string).pathname;
        if (options?.method !== 'POST' && pathname.startsWith('/v1/kv/')) {
            const key = decodeURIComponent(pathname.slice('/v1/kv/'.length));
            const found = data.get(key);
            return found?.value ? json({ key, ...found }) : json({}, 404);
        }
        if (options?.method !== 'POST') return json({ items: [...data].filter(([, value]) => value.value !== null)
            .map(([key, value]) => ({ key, ...value })) });
        const { mutations } = JSON.parse(options.body as string) as { mutations: { key: string; value: string | null; version: number }[] };
        const errors = mutations.filter((mutation) => (data.get(mutation.key)?.version ?? -1) !== mutation.version);
        if (errors.length) return json({ success: false, errors: errors.map((mutation) => ({ key: mutation.key, error: 'version-mismatch', ...data.get(mutation.key) })) }, 409);
        for (const mutation of mutations) data.set(mutation.key, { value: mutation.value, version: mutation.version + 1 });
        return json({ success: true, results: mutations.map((mutation) => ({ key: mutation.key, version: mutation.version + 1 })) });
    });
    return { fetcher, rows, client: (token = 'account-a') => createBuiltinTodoClient(credentials(token), { fetch: fetcher }) };
}

afterEach(() => vi.useRealTimers());

describe('builtin Todo format', () => {
    it('round trips Unicode, strips carrier version, and binds id to its KV key', () => {
        const record = item(1, { title: '中文 @ 🍃', note: '第一行\n第二行' });
        const encoded = encodeBuiltinTodo(record);
        expect(decodeBuiltinTodo(encoded, BUILTIN_TODO_PREFIX + record.id)).toEqual(expect.objectContaining({ title: record.title, note: record.note }));
        expect(decodeBuiltinTodo(encoded)).not.toHaveProperty('version');
        expect(decodeBuiltinTodo(encoded, BUILTIN_TODO_PREFIX + id(2))).toBeNull();
        expect(decodeBuiltinTodo('not-base64')).toBeNull();
    });
    it.each([
        { schemaVersion: 2 }, { id: 'bad/key' }, { title: ' ' }, { title: 'x'.repeat(TITLE_MAX_LENGTH + 1) },
        { note: 'x'.repeat(NOTE_MAX_LENGTH + 1) }, { status: 'doing' }, { order: Infinity },
        { order: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: NaN }, { updatedAt: -1 },
    ])('rejects unsupported or malformed data %j without truncating it', (patch) => {
        expect(parseBuiltinTodo({ ...item(1), ...patch })).toBeNull();
    });
    it('sorts deterministically without mutating the input', () => {
        const records = [item(2, { order: 1 }), item(1, { order: 1 }), item(3, { order: 0 })];
        expect(sortBuiltinTodos(records).map((record) => record.id)).toEqual([id(3), id(1), id(2)]);
        expect(records[0].id).toBe(id(2));
    });
});

describe('builtin Todo client', () => {
    it('persists CRUD and restore without an online machine or provider', async () => {
        const api = server();
        const client = api.client();
        const created = await client.create('  买牛奶  ', '明天');
        expect(created).toMatchObject({ title: '买牛奶', note: '明天', version: 0, status: 'open' });
        const done = await client.update(created, { status: 'done', title: '买燕麦奶' });
        expect(done.version).toBe(1);
        const restored = await client.update(done, { status: 'open' });
        expect(restored.version).toBe(2);
        expect((await client.list()).records).toEqual([restored]);
        await client.remove(restored);
        expect((await client.list()).records).toEqual([]);
        expect(api.rows('account-a').get(BUILTIN_TODO_PREFIX + created.id)).toEqual({ value: null, version: 3 });
    });
    it('captures account credentials and endpoint instead of following later changes', async () => {
        const api = server([item(1)]);
        const creds = credentials();
        const client = createBuiltinTodoClient(creds, { fetch: api.fetcher, serverUrl: 'https://fixed.test/' });
        creds.token = 'account-b';
        expect((await client.list()).records).toHaveLength(1);
        expect((await api.client('account-b').list()).records).toHaveLength(0);
        expect(api.fetcher.mock.calls[0][0]).toMatch(/^https:\/\/fixed.test\/v1\/kv\?/);
        expect(new Headers(api.fetcher.mock.calls[0][1]?.headers).get('X-Happy-Client')).toBe('test-client');
    });
    it('rejects invalid input before any request and does not apply extra patch fields', async () => {
        const api = server([item(1)]);
        await expect(api.client().create(' ')).rejects.toMatchObject({ code: 'validation' });
        expect(api.fetcher).not.toHaveBeenCalled();
        const changed = await api.client().update(item(1), { title: 'Changed', id: id(2), order: -1 } as never);
        expect(changed).toMatchObject({ id: id(1), order: 1024 });
    });
    it('does not overwrite a concurrent edit or revive a tombstone', async () => {
        const api = server([item(1)]);
        const client = api.client();
        const updated = await client.update(item(1), { title: 'Remote edit' });
        await expect(client.update(item(1), { status: 'done' })).rejects.toMatchObject({ code: 'conflict' });
        expect((await client.list()).records[0]).toMatchObject({ title: 'Remote edit', status: 'open' });
        await client.remove(updated);
        await expect(client.update(updated, { title: 'Stale edit' })).rejects.toMatchObject({ code: 'conflict' });
        expect((await client.list()).records).toEqual([]);
    });
    it('allows independent edits to different Todos', async () => {
        const api = server([item(1), item(2)]);
        await Promise.all([api.client().update(item(1), { title: 'First' }), api.client().update(item(2), { title: 'Second' })]);
        expect((await api.client().list()).records.map((record) => record.title)).toEqual(['First', 'Second']);
    });
    it('swaps two orders in one atomic write and refuses partial conflict', async () => {
        const api = server([item(1), item(2)]);
        const [a, b] = await api.client().move(item(1), item(2));
        expect([a.order, b.order, a.version, b.version]).toEqual([2048, 1024, 1, 1]);
        expect(JSON.parse(api.fetcher.mock.calls[0][1]!.body as string).mutations).toHaveLength(2);
        await expect(api.client().move(a, item(2))).rejects.toMatchObject({ code: 'conflict' });
        expect((await api.client().list()).records.map((record) => [record.id, record.version])).toEqual([[id(2), 1], [id(1), 1]]);
    });
    it('resolves equal orders when surrounding ranks permit a two-key swap', async () => {
        const records = [item(1, { order: 0 }), item(2, { order: 5 }), item(3, { order: 5 }), item(4, { order: 10 })];
        const api = server(records);
        await api.client().move(records[1], records[2]);
        expect((await api.client().list()).records.map((record) => record.id)).toEqual([id(1), id(3), id(2), id(4)]);
        expect(api.rows('account-a').get(BUILTIN_TODO_PREFIX + id(1))?.version).toBe(0);
        expect(api.rows('account-a').get(BUILTIN_TODO_PREFIX + id(4))?.version).toBe(0);
    });
    it('resolves an equal-order boundary pair without crossing other tied items', async () => {
        const records = [1, 2, 3].map((n) => item(n, { order: 5 }));
        const api = server(records);
        await api.client().move(records[1], records[0]);
        expect((await api.client().list()).records.map((record) => record.id)).toEqual([id(2), id(1), id(3)]);
    });
    it('rejects an interior tie that cannot safely swap with only two mutations', async () => {
        const records = [1, 2, 3, 4].map((n) => item(n, { order: 5 }));
        const api = server(records);
        await expect(api.client().move(records[1], records[2])).rejects.toMatchObject({ code: 'order-collision' });
        expect(api.fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    });
    it('counts malformed and unknown schema rows and exposes a full-page truncation', async () => {
        const good = { key: BUILTIN_TODO_PREFIX + id(1), value: encodeBuiltinTodo(item(1)), version: 0 };
        const fetcher = vi.fn<typeof fetch>(async () => json({ items: [good, ...Array(999).fill({ key: 'bad', value: 'bad', version: 0 })] }));
        const result = await createBuiltinTodoClient(credentials(), { fetch: fetcher }).list();
        expect(result).toMatchObject({ truncated: true, invalidCount: 999, records: [item(1)] });
    });
    it('preflights the UI item limit without sending a mutation', async () => {
        const api = server(Array.from({ length: MAX_COUNT }, (_, index) => item(index + 1)));
        await expect(api.client().create('one too many')).rejects.toMatchObject({ code: 'limit' });
        expect(api.fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([401, 413, 429, 500])('fails HTTP %s once without retries', async (status) => {
        const fetcher = vi.fn<typeof fetch>(async () => json({}, status));
        await expect(createBuiltinTodoClient(credentials(), { fetch: fetcher }).list()).rejects.toMatchObject({ code: 'http', httpStatus: status });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('does not repeat a create if its commit succeeded but the response was lost', async () => {
        const api = server();
        const fetcher = vi.fn<typeof fetch>(async (url, options) => {
            const result = await api.fetcher(url, options);
            if (options?.method === 'POST') throw new TypeError('connection lost after commit');
            return result;
        });
        await expect(createBuiltinTodoClient(credentials(), { fetch: fetcher }).create('Keep exactly one')).rejects.toMatchObject({ code: 'network' });
        expect((await api.client().list()).records).toHaveLength(1);
        expect(fetcher).toHaveBeenCalledTimes(2); // preflight read + one write
    });
    it('reuses the pending id after a lost creation response instead of duplicating the task', async () => {
        const api = server();
        const fetcher = vi.fn<typeof fetch>(async (url, options) => {
            const result = await api.fetcher(url, options);
            if (options?.method === 'POST') throw new TypeError('connection lost after commit');
            return result;
        });
        const client = createBuiltinTodoClient(credentials(), { fetch: fetcher });
        await expect(client.create('Keep exactly one')).rejects.toMatchObject({ code: 'network' });
        const recovered = await client.create('Keep exactly one');
        expect(recovered.title).toBe('Keep exactly one');
        expect((await api.client().list()).records).toHaveLength(1);
        expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    });
    it('retries a definitely absent creation with the same id and coalesces concurrent clicks', async () => {
        const api = server();
        let first = true;
        const fetcher = vi.fn<typeof fetch>(async (url, options) => {
            if (options?.method === 'POST' && first) { first = false; throw new TypeError('offline before commit'); }
            return api.fetcher(url, options);
        });
        const client = createBuiltinTodoClient(credentials(), { fetch: fetcher });
        await expect(client.create('Retry me')).rejects.toMatchObject({ code: 'network' });
        const [a, b] = await Promise.all([client.create('Retry me'), client.create('Retry me')]);
        expect(a.id).toBe(b.id);
        const writes = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
        expect(writes).toHaveLength(2);
        const keys = writes.map(([, options]) => JSON.parse(options!.body as string).mutations[0].key);
        expect(keys[0]).toBe(keys[1]);
        expect((await api.client().list()).records).toHaveLength(1);
    });
    it('keeps different payloads separate while confirming an uncertain creation', async () => {
        const api = server();
        let first = true;
        const fetcher = vi.fn<typeof fetch>(async (url, options) => {
            const result = await api.fetcher(url, options);
            if (options?.method === 'POST' && first) { first = false; throw new TypeError('lost response'); }
            return result;
        });
        const client = createBuiltinTodoClient(credentials(), { fetch: fetcher });
        await expect(client.create('First')).rejects.toMatchObject({ code: 'network' });
        const second = await client.create('Second');
        const firstTask = await client.create('First');
        expect(firstTask.id).not.toBe(second.id);
        expect((await api.client().list()).records).toHaveLength(2);
    });
    it('aborts a hung request and reports timeout rather than retrying', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const request = createBuiltinTodoClient(credentials(), { fetch: fetcher, timeoutMs: 30 }).list();
        const assertion = expect(request).rejects.toMatchObject({ code: 'timeout' });
        await vi.advanceTimersByTimeAsync(30);
        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('rejects successful HTTP with a partial or unrelated write acknowledgement', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => json({ success: true, results: [{ key: BUILTIN_TODO_PREFIX + id(2), version: 1 }] }));
        await expect(createBuiltinTodoClient(credentials(), { fetch: fetcher }).update(item(1), { status: 'done' }))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });
});


describe('stable CLI creation IDs', () => {
    it('reconciles creation across independent client instances and rejects changed content', async () => {
        const api = server();
        const first = await api.client().create('中文 @ task', '备注', id(700));
        const retried = await api.client().create('中文 @ task', '备注', id(700));
        expect(retried).toEqual(first);
        expect((await api.client().list()).records).toHaveLength(1);
        await expect(api.client().create('different', '备注', id(700))).rejects.toMatchObject({ code: 'conflict' });
        expect(await api.client().get(id(700))).toEqual(first);
        await api.client().remove(first);
        expect(await api.client().get(id(700))).toBeNull();
        await expect(api.client().create('中文 @ task', '备注', id(700))).rejects.toMatchObject({ code: 'conflict' });
    });
    it('recovers a lost create acknowledgement using the same ID in a new client', async () => {
        const api = server();
        let loseAck = true;
        const fetcher: typeof fetch = async (url, options) => {
            const response = await api.fetcher(url, options);
            if (options?.method === 'POST' && loseAck) { loseAck = false; throw new Error('lost response'); }
            return response;
        };
        await expect(createBuiltinTodoClient(credentials(), { fetch: fetcher }).create('one', '', id(701))).rejects.toMatchObject({ code: 'network' });
        const recovered = await createBuiltinTodoClient(credentials(), { fetch: fetcher }).create('one', '', id(701));
        expect(recovered.id).toBe(id(701));
        expect((await api.client().list()).records).toHaveLength(1);
    });
    it('rejects malformed single records and disables redirects on authenticated requests', async () => {
        const api = server();
        await expect(api.client().get('invalid')).rejects.toMatchObject({ code: 'validation' });
        expect(api.fetcher).not.toHaveBeenCalled();
        await api.client().get(id(703));
        expect(api.fetcher.mock.calls[0][1]?.redirect).toBe('error');
        const client = createBuiltinTodoClient(credentials(), { fetch: async () => json({ key: 'wrong', value: encodeBuiltinTodo(item(1)), version: 0 }) });
        await expect(client.get(id(1))).rejects.toMatchObject({ code: 'invalid-response' });
    });
});
