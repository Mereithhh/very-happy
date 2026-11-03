import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('@/modules/todo/builtinTodoClient', () => ({ authenticatedBuiltinTodoClient: vi.fn(async () => client), assertAccountTodosAllowed: vi.fn(async () => {}) }));
// B-874: these cases are the classic store — the server has no Issues (old server / switch off), so todo falls back to KV.
const issues = vi.hoisted(() => {
    class IssuesUnsupportedError extends Error {}
    class IssueRequestError extends Error {
        constructor(public status: number, public code: string | null, public details: Record<string, unknown>) { super(code ? `Issue request failed: ${code}` : `Issue request failed (HTTP ${status})`); }
    }
    return { IssuesUnsupportedError, IssueRequestError, client: { isDisabled: () => false, importLegacyTodos: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});
vi.mock('@/issues/client', () => ({ IssuesUnsupportedError: issues.IssuesUnsupportedError, IssueRequestError: issues.IssueRequestError, sharedIssuesClient: () => issues.client, importLegacyTodosOnce: async (c: { importLegacyTodos: () => Promise<unknown> }) => { await c.importLegacyTodos().catch(() => undefined); } }));
vi.mock('@/modules/todo/skill', () => ({ BUILTIN_TODO_SKILL: 'official skill body' }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://relay.example' } }));
import { authenticatedBuiltinTodoClient } from '@/modules/todo/builtinTodoClient';
import { handleTodoCommand, parseTodoArgs } from './todo';
import { IssueRequestError, IssuesUnsupportedError } from '@/issues/client';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Todo command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        for (const key of ['importLegacyTodos', 'list', 'get', 'create', 'update', 'remove'] as const) issues.client[key].mockImplementation(async () => { throw new IssuesUnsupportedError(); });
    });
    afterEach(() => vi.restoreAllMocks());
    it('prints help and the official skill without credentials', async () => {
        for (const args of [[], ['--help'], ['add', '--help'], ['skill']]) await handleTodoCommand(args);
        expect(authenticatedBuiltinTodoClient).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenLastCalledWith('official skill body');
    });
    it.each([
        ['list', '--unknown'], ['list', '--title', 'x'], ['list', id], ['get'], ['get', 'bad'],
        ['add', '--title', 'x'], ['add', '--id', id, '--title'], ['add', '--id', id, '--title', ''],
        ['add', '--id', id, '--title', 'x', '--id', id], ['edit', id, '--version', '0'],
        ['edit', id, '--title', 'x'], ['delete', id, '--version', '-1'], ['delete', id, '--version', '1.2'],
        ['delete', id, '--version', '9007199254740992'], ['skill', '--host', 'claude'], ['list', '--help', '--help'],
    ])('rejects invalid arguments before authentication: %j', async (...args) => {
        await expect(handleTodoCommand(args)).rejects.toThrow();
        expect(authenticatedBuiltinTodoClient).not.toHaveBeenCalled();
    });
    it('accepts explicit empty note and version zero', () => {
        expect(parseTodoArgs(['edit', id, '--version', '0', '--note', ''])).toMatchObject({ action: 'edit', id, version: 0, note: '' });
    });
    it('accepts equals syntax with leading dashes, embedded equals, and empty notes', () => {
        expect(parseTodoArgs(['add', '--id', id, '--title=--help 文案修复', '--note=---\nkind: task=a\n---']))
            .toMatchObject({ title: '--help 文案修复', note: '---\nkind: task=a\n---' });
        expect(parseTodoArgs(['edit', id, '--version', '0', '--note='])).toMatchObject({ note: '' });
    });
    it.each([
        ['add', '--id', id, '--title=x', '--title', 'y'],
        ['add', '--id', id, '--title', 'x', '--title=y'],
        ['edit', id, '--version', '0', '--note=', '--note=x'],
        ['add', '--id', id, '--title='],
        ['list', '--unknown=x'], ['list', '--note=x'],
        ['delete', id, '--version=0'],
    ])('keeps equals arguments strict: %j', async (...args) => {
        await expect(handleTodoCommand(args)).rejects.toThrow();
        expect(authenticatedBuiltinTodoClient).not.toHaveBeenCalled();
    });
    it('passes leading dashes literally to create and edit', async () => {
        client.create.mockResolvedValue({ id, version: 0 });
        await handleTodoCommand(['add', '--id', id, '--title=--help', '--note=---\nkind: task=a\n---']);
        expect(client.create).toHaveBeenCalledWith('--help', '---\nkind: task=a\n---', id);
        client.get.mockResolvedValue({ id, version: 0 });
        client.update.mockResolvedValue({ id, version: 1 });
        await handleTodoCommand(['edit', id, '--version', '0', '--note=--literal']);
        expect(client.update).toHaveBeenCalledWith({ id, version: 0 }, { note: '--literal' });
    });
    it('passes the stable create ID and returns endpoint-tagged JSON', async () => {
        client.create.mockResolvedValue({ id, title: '中文 😀', version: 0 });
        await handleTodoCommand(['add', '--id', id, '--title', '中文 😀']);
        expect(client.create).toHaveBeenCalledWith('中文 😀', '', id);
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({ serverUrl: 'https://relay.example', result: { id, title: '中文 😀', version: 0 } });
    });
    it('retains truncation and invalid counts in list JSON', async () => {
        client.list.mockResolvedValue({ records: [], truncated: true, invalidCount: 2 });
        await handleTodoCommand(['list']);
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result).toEqual({ records: [], truncated: true, invalidCount: 2 });
    });
    it('returns null for a missing task lookup', async () => {
        client.get.mockResolvedValue(null);
        await handleTodoCommand(['get', id]);
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result).toBeNull();
    });
    it.each(['edit', 'complete', 'reopen', 'delete'])('does not write stale %s versions', async (action) => {
        client.get.mockResolvedValue({ id, version: 3 });
        await expect(handleTodoCommand([action, id, '--version', '2', ...(action === 'edit' ? ['--note', 'draft'] : [])])).rejects.toThrow('conflict');
        expect(client.update).not.toHaveBeenCalled();
        expect(client.remove).not.toHaveBeenCalled();
    });
    it.each(['complete', 'reopen'])('updates %s with the observed version', async (action) => {
        const record = { id, version: 2 };
        client.get.mockResolvedValue(record);
        client.update.mockResolvedValue({ id, version: 3 });
        await handleTodoCommand([action, id, '--version', '2']);
        expect(client.update).toHaveBeenCalledWith(record, { status: action === 'complete' ? 'done' : 'open' });
    });
    it('preserves edit patch and does not retry unknown write outcomes', async () => {
        client.get.mockResolvedValue({ id, version: 2 });
        client.update.mockRejectedValue(new Error('outcome unknown'));
        await expect(handleTodoCommand(['edit', id, '--version', '2', '--note', ''])).rejects.toThrow('unknown');
        expect(client.update).toHaveBeenCalledExactlyOnceWith({ id, version: 2 }, { note: '' });
        expect(console.log).not.toHaveBeenCalled();
    });
    it('deletes only after matching the version', async () => {
        const record = { id, version: 2 };
        client.get.mockResolvedValue(record);
        await handleTodoCommand(['delete', id, '--version', '2']);
        expect(client.remove).toHaveBeenCalledWith(record);
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result).toEqual({ id, deleted: true });
    });
    it('never recreates a missing task for a mutation', async () => {
        client.get.mockResolvedValue(null);
        await expect(handleTodoCommand(['complete', id, '--version', '2'])).rejects.toThrow('not found');
        expect(client.update).not.toHaveBeenCalled();
        expect(client.create).not.toHaveBeenCalled();
    });
});

describe('Todo command on a server with Issues (B-874 alias layer, spec §8)', () => {
    const issue = (over: Record<string, unknown> = {}) => ({
        id, number: 7, key: 'VH-7', title: 'T', description: 'N', status: 'todo', priority: 'none', assignee: { kind: 'none' }, projectId: null,
        labels: [], dueAt: null, parentId: null, sortOrder: 5, createdBy: { kind: 'user' }, statusRunId: null, latestRunId: null, legacyTodoId: null,
        createdAt: 1, updatedAt: 2, statusChangedAt: 2, startedAt: null, completedAt: null, deletedAt: null, version: 3, ...over,
    });
    const api = () => ({
        isDisabled: () => false, importLegacyTodos: vi.fn(async () => ({})),
        list: vi.fn(async () => ({ issues: [issue()], nextCursor: null, asOf: 1 })),
        get: vi.fn(async () => ({ issue: issue(), comments: [], runs: [], children: [] })),
        create: vi.fn(async () => ({ issue: issue() })), update: vi.fn(async (_id: string, p: any) => ({ issue: issue({ ...p, status: p.status ?? 'todo', version: 4 }) })),
        remove: vi.fn(async () => ({ issue: issue({ deletedAt: 9 }) })),
    });
    const out = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]).result;
    beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => vi.restoreAllMocks());
    it('list = every unassigned issue, open and done, in the KV record shape and KV order (imports legacy KV first); --all is the same (B-874e)', async () => {
        const c = api();
        const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
        c.list.mockResolvedValue({ issues: [issue({ legacyTodoId: b, sortOrder: 5, createdAt: 0 }), issue({ legacyTodoId: a, status: 'done', sortOrder: 5, createdAt: 9 }), issue({ sortOrder: 1 })], nextCursor: null, asOf: 1 });
        await handleTodoCommand(['list'], { issues: c as any });
        expect(c.importLegacyTodos).toHaveBeenCalled();
        expect(c.list).toHaveBeenCalledWith({ assigneeKind: 'none', limit: expect.any(Number) });
        const listed = out();
        // KV order: order, then id — not createdAt.
        expect(listed.records.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([[id, 'open'], [a, 'done'], [b, 'open']]);
        expect(listed.records[0]).toEqual({ schemaVersion: 1, id, key: 'VH-7', title: 'T', note: 'N', status: 'open', order: 1, createdAt: 1, updatedAt: 2, version: 3 });
        expect(listed).toMatchObject({ truncated: false, invalidCount: 0 });
        await handleTodoCommand(['list', '--all'], { issues: c as any });
        expect(c.list).toHaveBeenLastCalledWith({ assigneeKind: 'none', limit: expect.any(Number) });
        expect(out()).toEqual(listed);
        expect(authenticatedBuiltinTodoClient).not.toHaveBeenCalled();
    });
    it('add = an unassigned todo issue, the UUID is the idempotency key (Q10)', async () => {
        const c = api();
        c.create.mockResolvedValue({ issue: issue({ title: 'Buy milk', description: 'n' }) });
        await handleTodoCommand(['add', '--id', id, '--title', 'Buy milk', '--note', 'n'], { issues: c as any });
        expect(c.create).toHaveBeenCalledWith({ title: 'Buy milk', description: 'n', status: 'todo', assignee: { kind: 'none' }, requestId: id, legacyTodoId: id });
    });
    it('B-874d: the add UUID stays the todo id — every output shows U, every write targets the issue the server resolved U to', async () => {
        const u = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        const c = api();
        const aliased = (over: Record<string, unknown> = {}) => issue({ legacyTodoId: u, ...over });
        c.create.mockResolvedValue({ issue: aliased() });
        c.get.mockResolvedValue({ issue: aliased(), comments: [], runs: [], children: [] });
        c.update.mockImplementation(async (_id: string, p: any) => ({ issue: aliased({ ...p, status: p.status ?? 'todo', version: 4 }) }));
        await handleTodoCommand(['add', '--id', u, '--title', 'T', '--note', 'N'], { issues: c as any });
        expect(out()).toMatchObject({ id: u, key: 'VH-7' });
        await handleTodoCommand(['get', u], { issues: c as any });
        expect(c.get).toHaveBeenLastCalledWith(u);
        expect(out()).toMatchObject({ id: u });
        for (const action of ['edit', 'complete', 'reopen'] as const) {
            await handleTodoCommand([action, u, '--version', '3', ...(action === 'edit' ? ['--title', 'T2'] : [])], { issues: c as any });
            expect(c.update).toHaveBeenLastCalledWith(id, expect.objectContaining({ ifVersion: 3 }));
            expect(out()).toMatchObject({ id: u });
        }
        await handleTodoCommand(['delete', u, '--version', '3'], { issues: c as any });
        expect(c.remove).toHaveBeenCalledWith(id);
        expect(out()).toEqual({ id: u, deleted: true });
        // Reused id: different content or a deleted todo fail with the KV store's words.
        await expect(handleTodoCommand(['add', '--id', u, '--title', 'Other', '--note', 'N'], { issues: c as any })).rejects.toThrow('This Todo ID already has different content');
        c.create.mockRejectedValueOnce(new IssueRequestError(404, 'issue_todo_deleted', {}));
        await expect(handleTodoCommand(['add', '--id', u, '--title', 'T', '--note', 'N'], { issues: c as any })).rejects.toThrow('Todo changed on another device; refresh before retrying');
        // An issue created elsewhere (Web / `issue create`) has no todo id and keeps its issue id.
        c.get.mockResolvedValueOnce({ issue: issue(), comments: [], runs: [], children: [] });
        await handleTodoCommand(['get', 'VH-7'], { issues: c as any });
        expect(out()).toMatchObject({ id });
    });
    it('complete / reopen / edit map to PATCH with ifVersion; delete is the soft delete; get accepts VH-N', async () => {
        const c = api();
        await handleTodoCommand(['complete', 'VH-7', '--version', '3'], { issues: c as any });
        expect(c.update).toHaveBeenLastCalledWith(id, { status: 'done', ifVersion: 3 });
        expect(out()).toMatchObject({ status: 'done', version: 4 });
        await handleTodoCommand(['reopen', id, '--version', '3'], { issues: c as any });
        expect(c.update).toHaveBeenLastCalledWith(id, { status: 'todo', ifVersion: 3 });
        await handleTodoCommand(['edit', id, '--version', '3', '--note', 'x'], { issues: c as any });
        expect(c.update).toHaveBeenLastCalledWith(id, { description: 'x', ifVersion: 3 });
        await handleTodoCommand(['delete', id, '--version', '3'], { issues: c as any });
        expect(c.remove).toHaveBeenCalledWith(id);
        expect(out()).toEqual({ id, deleted: true });
    });
    it('stale versions never write; a deleted issue reads as null; a legacy KV id resolves through legacyTodoId', async () => {
        const c = api();
        await expect(handleTodoCommand(['complete', id, '--version', '2'], { issues: c as any })).rejects.toThrow('conflict');
        expect(c.update).not.toHaveBeenCalled();
        c.update.mockRejectedValueOnce(new IssueRequestError(409, 'issue_version_conflict', {}));
        await expect(handleTodoCommand(['complete', id, '--version', '3'], { issues: c as any })).rejects.toThrow('conflict');
        c.get.mockResolvedValueOnce({ issue: issue({ deletedAt: 5 }), comments: [], runs: [], children: [] });
        await handleTodoCommand(['get', id], { issues: c as any });
        expect(out()).toBeNull();
        const legacy = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        c.get.mockRejectedValueOnce(new IssueRequestError(404, 'issue_not_found', {}));
        c.list.mockResolvedValueOnce({ issues: [issue({ legacyTodoId: legacy })], nextCursor: null, asOf: 1 });
        await handleTodoCommand(['get', legacy], { issues: c as any });
        expect(out()).toMatchObject({ id: legacy, key: 'VH-7' });
    });
    it('falls back to the classic store only when the server has no Issues; VH-N then needs a UUID', async () => {
        const c = { ...api(), list: vi.fn(async () => { throw new IssuesUnsupportedError(); }) };
        client.list.mockResolvedValue({ records: [], truncated: false, invalidCount: 0 });
        await handleTodoCommand(['list'], { issues: c as any });
        expect(client.list).toHaveBeenCalled();
        const d = { ...api(), get: vi.fn(async () => { throw new IssuesUnsupportedError(); }) };
        await expect(handleTodoCommand(['get', 'VH-7'], { issues: d as any })).rejects.toThrow('use the Todo UUID');
        const e = { ...api(), list: vi.fn(async () => { throw new IssueRequestError(500, null, {}); }) };
        await expect(handleTodoCommand(['list'], { issues: e as any })).rejects.toThrow('HTTP 500');
        expect(client.list).toHaveBeenCalledTimes(1);
    });
});
