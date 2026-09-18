import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { kvGet } from '@/app/kv/kvGet';
import { kvMutate } from '@/app/kv/kvMutate';
import { warn } from '@/utils/log';
import { recordToolHistory, toolHistoryKey, type ToolHistoryEntry } from '@/app/kv/toolHistory';
import { clipboardHandler } from '@/app/api/socket/clipboardHandler';
import { filePreviewHandler } from '@/app/api/socket/filePreviewHandler';

vi.mock('@/app/kv/kvGet', () => ({ kvGet: vi.fn() }));
vi.mock('@/app/kv/kvMutate', () => ({ kvMutate: vi.fn() }));
vi.mock('@/utils/log', () => ({ warn: vi.fn() }));

function encode(entries: ToolHistoryEntry[]): string {
    return privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify({ version: 1, entries })));
}

function decode(value: string) {
    return JSON.parse(new TextDecoder().decode(privacyKit.decodeBase64(value))) as { version: number; entries: ToolHistoryEntry[] };
}

function memoryStore() {
    const store = new Map<string, { version: number; value: string | null }>();
    vi.mocked(kvGet).mockImplementation(async ({ uid }, key) => {
        const current = store.get(JSON.stringify([uid, key]));
        return current?.value ? { key, value: current.value, version: current.version } : null;
    });
    vi.mocked(kvMutate).mockImplementation(async ({ uid }, [mutation]) => {
        const address = JSON.stringify([uid, mutation.key]);
        const current = store.get(address);
        if ((current?.version ?? -1) !== mutation.version) {
            return { success: false, errors: [{ key: mutation.key, error: 'version-mismatch', version: current?.version ?? -1, value: current?.value ?? null }] };
        }
        store.set(address, { version: mutation.version + 1, value: mutation.value });
        return { success: true, results: [{ key: mutation.key, version: mutation.version + 1 }] };
    });
    return store;
}

beforeEach(() => vi.resetAllMocks());

describe('tool history persistence', () => {
    it('isolates account/session/terminal keys and skips old machine pushes without a terminal', async () => {
        const store = memoryStore();
        const session = { sourceType: 'session' as const, sessionId: 's/1' };
        const terminal = { sourceType: 'machine' as const, machineId: 'm/1', terminalId: 't1' };
        await recordToolHistory('u1', session, { kind: 'clipboard', payload: 'session', enc: false });
        await recordToolHistory('u2', session, { kind: 'clipboard', payload: 'other account', enc: false });
        await recordToolHistory('u1', terminal, { kind: 'preview', payload: '/a', enc: false, mode: 'diff' });
        await recordToolHistory('u1', { sourceType: 'machine', machineId: 'm/1' }, { kind: 'clipboard', payload: 'legacy', enc: false });
        expect(toolHistoryKey(session)).toBe('tool-history.v1/session/s%2F1');
        expect(toolHistoryKey(terminal)).toBe('tool-history.v1/terminal/m%2F1/t1');
        expect(store.size).toBe(3);
        expect(vi.mocked(kvMutate).mock.calls).toHaveLength(3);
        const saved = decode(store.get(JSON.stringify(['u1', toolHistoryKey(terminal)]))!.value!);
        expect(saved.entries[0]).toMatchObject({ kind: 'preview', payload: '/a', enc: false, mode: 'diff' });
        expect(saved.entries[0].id).toMatch(/^[0-9a-f-]{36}$/);
        expect(saved.entries[0].createdAt).toBeGreaterThan(0);
    });

    it('serializes concurrent calls, preserves duplicate content, and keeps the latest 50', async () => {
        const store = memoryStore();
        const source = { sourceType: 'session' as const, sessionId: 's1' };
        await Promise.all(Array.from({ length: 50 }, (_, index) => recordToolHistory('u', source, {
            kind: 'clipboard', payload: `${index}`, enc: false,
        })));
        await Promise.all(Array.from({ length: 5 }, (_, offset) => {
            const index = 50 + offset;
            return recordToolHistory('u', source, {
            kind: 'clipboard', payload: index >= 53 ? 'duplicate' : `${index}`, enc: false,
            });
        }));
        const saved = decode(store.get(JSON.stringify(['u', toolHistoryKey(source)]))!.value!);
        expect(saved.entries).toHaveLength(50);
        expect(saved.entries.slice(0, 3).map(entry => entry.payload)).toEqual(['duplicate', 'duplicate', '52']);
        expect(new Set(saved.entries.map(entry => entry.id)).size).toBe(50);
        expect(saved.entries.at(-1)?.payload).toBe('5');
        expect(warn).not.toHaveBeenCalled();
    });

    it('bounds stalled work at 50 per scope while letting another scope save and recovers after drain', async () => {
        memoryStore();
        let resume!: () => void;
        const blocked = new Promise<void>(resolve => { resume = resolve; });
        vi.mocked(kvGet).mockImplementationOnce(async () => { await blocked; return null; });
        const source = { sourceType: 'session' as const, sessionId: 'stalled' };
        const pending = Array.from({ length: 50 }, () => recordToolHistory('u', source, { kind: 'clipboard', payload: 'queued', enc: false }));
        await recordToolHistory('u', source, { kind: 'clipboard', payload: 'dropped private body', enc: false });
        await recordToolHistory('u', { sourceType: 'session', sessionId: 'other' }, { kind: 'preview', payload: '/a', enc: false });
        expect(kvMutate).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith({ module: 'tool-history', kind: 'clipboard', reason: 'queue-full' }, 'Tool history was not saved');
        expect(JSON.stringify(vi.mocked(warn).mock.calls)).not.toContain('dropped private body');
        resume();
        await Promise.all(pending);
        await recordToolHistory('u', source, { kind: 'clipboard', payload: 'after drain', enc: false });
        expect(kvMutate).toHaveBeenCalledTimes(52);
    });

    it('bounds all stalled scopes at 200 pending writes and releases the global allowance', async () => {
        memoryStore();
        const read = vi.mocked(kvGet).getMockImplementation()!;
        let resume!: () => void;
        const blocked = new Promise<void>(resolve => { resume = resolve; });
        vi.mocked(kvGet).mockImplementation(async (...args) => { await blocked; return read(...args); });
        const pending = Array.from({ length: 200 }, (_, index) => recordToolHistory('u', {
            sourceType: 'session', sessionId: `scope-${Math.floor(index / 50)}`,
        }, { kind: 'clipboard', payload: 'queued', enc: false }));
        await recordToolHistory('other-user', { sourceType: 'session', sessionId: 'new-scope' }, { kind: 'preview', payload: '/a', enc: false });
        expect(kvMutate).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        resume();
        await Promise.all(pending);
        await recordToolHistory('other-user', { sourceType: 'session', sessionId: 'new-scope' }, { kind: 'preview', payload: '/a', enc: false });
        expect(kvMutate).toHaveBeenCalledTimes(201);
    });

    it('retries a competing writer and a tombstone using the conflict value/version', async () => {
        vi.mocked(kvGet).mockResolvedValue(null);
        const competing: ToolHistoryEntry = { id: 'other', kind: 'preview', payload: '/older', enc: false, createdAt: 1 };
        vi.mocked(kvMutate)
            .mockResolvedValueOnce({ success: false, errors: [{ key: 'tool-history.v1/session/s1', error: 'version-mismatch', version: 4, value: null }] })
            .mockResolvedValueOnce({ success: false, errors: [{ key: 'tool-history.v1/session/s1', error: 'version-mismatch', version: 5, value: encode([competing]) }] })
            .mockResolvedValueOnce({ success: true });
        await recordToolHistory('u', { sourceType: 'session', sessionId: 's1' }, { kind: 'clipboard', payload: 'new', enc: true });
        const mutations = vi.mocked(kvMutate).mock.calls.map(([, values]) => values[0]);
        expect(mutations.map(mutation => mutation.version)).toEqual([-1, 4, 5]);
        expect(decode(mutations[2].value!).entries.map(entry => entry.payload)).toEqual(['new', '/older']);
    });

    it('evicts whole old entries by decoded JSON bytes, including JSON escaping overhead', async () => {
        const store = memoryStore();
        const source = { sourceType: 'session' as const, sessionId: 's1' };
        await Promise.all(Array.from({ length: 8 }, () => recordToolHistory('u', source, {
            kind: 'clipboard', payload: '\\'.repeat(48 * 1024), enc: true,
        })));
        const value = store.get(JSON.stringify(['u', toolHistoryKey(source)]))!.value!;
        expect(privacyKit.decodeBase64(value).byteLength).toBeLessThanOrEqual(240 * 1024);
        const entries = decode(value).entries;
        expect(entries).toHaveLength(2);
        expect(entries.every(entry => entry.payload === '\\'.repeat(48 * 1024))).toBe(true);
    });

    it('never slices oversized ciphertext and retains the encrypted empty-body marker', async () => {
        memoryStore();
        await recordToolHistory('u', { sourceType: 'session', sessionId: 's' }, {
            kind: 'clipboard', payload: '密'.repeat(20 * 1024), enc: true, totalBytes: 60000,
        });
        const mutation = vi.mocked(kvMutate).mock.calls[0][1][0];
        expect(decode(mutation.value!).entries[0]).toMatchObject({ payload: '', enc: true, truncated: true, totalBytes: 60000 });
    });

    it('retains a call marker when JSON-escaping makes one legacy body exceed the entire log', async () => {
        memoryStore();
        await recordToolHistory('u', { sourceType: 'session', sessionId: 's' }, {
            kind: 'clipboard', payload: '\0'.repeat(48 * 1024), enc: false,
        });
        const mutation = vi.mocked(kvMutate).mock.calls[0][1][0];
        expect(decode(mutation.value!).entries[0]).toMatchObject({ payload: '', enc: false, truncated: true });
    });

    it('bounds CAS conflicts and swallows quota/storage failures without logging bodies', async () => {
        vi.mocked(kvGet).mockResolvedValue(null);
        vi.mocked(kvMutate).mockResolvedValue({ success: false, errors: [{ key: 'tool-history.v1/session/s', error: 'version-mismatch', version: 1, value: null }] });
        await recordToolHistory('u', { sourceType: 'session', sessionId: 's' }, { kind: 'clipboard', payload: 'private content', enc: false });
        expect(kvMutate).toHaveBeenCalledTimes(8);
        vi.mocked(kvGet).mockRejectedValueOnce(new Error('storage failure private content'));
        await expect(recordToolHistory('u', { sourceType: 'session', sessionId: 's' }, { kind: 'clipboard', payload: 'private content', enc: false })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(vi.mocked(warn).mock.calls)).not.toContain('private content');
    });

    it('repairs malformed stored history and releases the queue after an error', async () => {
        const store = memoryStore();
        const source = { sourceType: 'session' as const, sessionId: 's' };
        store.set(JSON.stringify(['u', toolHistoryKey(source)]), { version: 2, value: 'broken' });
        vi.mocked(kvMutate).mockRejectedValueOnce(new Error('quota'));
        await recordToolHistory('u', source, { kind: 'clipboard', payload: 'failed', enc: false });
        await recordToolHistory('u', source, { kind: 'clipboard', payload: 'saved', enc: false });
        expect(decode(store.get(JSON.stringify(['u', toolHistoryKey(source)]))!.value!).entries.map(entry => entry.payload)).toEqual(['saved']);
    });

    it.each([
        { register: clipboardHandler, event: 'clipboard-push' },
        { register: filePreviewHandler, event: 'file-preview-push' },
    ])('keeps $event live delivery independent of a failed history write', async ({ register, event }) => {
        const handlers = new Map<string, (data: unknown) => Promise<void>>();
        const emit = vi.fn();
        const socket = { on: (name: string, handler: (data: unknown) => Promise<void>) => handlers.set(name, handler) } as any;
        const io = { to: () => ({ emit }) } as any;
        let rejectWrite!: (error: Error) => void;
        let writeStarted!: () => void;
        const started = new Promise<void>(resolve => { writeStarted = resolve; });
        vi.mocked(kvGet).mockResolvedValue(null);
        vi.mocked(kvMutate).mockImplementation(() => new Promise((_, reject) => {
            rejectWrite = reject;
            writeStarted();
        }));
        register('u', socket, io, { connectionType: 'session-scoped', sessionId: 's' });
        const complete = handlers.get(event)!({ payload: 'private live payload', enc: true });
        expect(emit).toHaveBeenCalledWith(event, expect.objectContaining({ payload: 'private live payload', sessionId: 's' }));
        // Wait on the actual write invocation, without timers or detached work.
        await started;
        rejectWrite(new Error('quota private live payload'));
        await expect(complete).resolves.toBeUndefined();
        expect(emit).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(vi.mocked(warn).mock.calls)).not.toContain('private live payload');
    });
});
