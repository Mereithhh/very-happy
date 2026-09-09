import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('@/modules/todo/builtinTodoClient', () => ({ authenticatedBuiltinTodoClient: vi.fn(async () => client) }));
vi.mock('@/modules/todo/skill', () => ({ BUILTIN_TODO_SKILL: 'official skill body' }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://relay.example' } }));
import { authenticatedBuiltinTodoClient } from '@/modules/todo/builtinTodoClient';
import { handleTodoCommand, parseTodoArgs } from './todo';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Todo command', () => {
    beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
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
