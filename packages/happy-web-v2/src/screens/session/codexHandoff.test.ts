import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { composeHandoffDraft, handoffFromMessages, readHandoffResponse, startCodexHandoff, type HandoffDeps } from './codexHandoff';

const labels = { intro: 'INTRO', summary: 'SUMMARY', recent: 'RECENT', user: 'U', assistant: 'C', outro: 'OUTRO' };
const session = {
    id: 'old', permissionMode: 'yolo',
    metadata: { machineId: 'm1', path: '/work/dir', codexThreadId: 'thread-1', flavor: 'codex' },
} as unknown as Session;
const loaded = [
    { kind: 'agent-text', id: 'a', seq: 2, text: '还在跑' },
    { kind: 'user-text', id: 'u', seq: 1, text: '现在什么进展' },
    { kind: 'user-text', id: 'x', seq: 3, text: 'never ran', cancelReason: 'aborted' },
] as unknown as Message[];

function makeDeps(rpcResult: unknown | Error): HandoffDeps & { drafts: Record<string, string> } {
    const drafts: Record<string, string> = {};
    return {
        drafts,
        rpc: vi.fn(async () => { if (rpcResult instanceof Error) throw rpcResult; return rpcResult; }),
        spawn: vi.fn(async () => ({ type: 'success' as const, sessionId: 'new' })),
        loadedMessages: () => loaded,
        setDraft: (id, draft) => { drafts[id] = draft; },
        refresh: async () => {},
    };
}

describe('B-901 codex handoff (new session with a summary)', () => {
    it('composes the draft from the summary and the recent messages', () => {
        expect(composeHandoffDraft({ summary: '## P\n- 40%', recent: [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'ok' }] }, labels))
            .toBe('INTRO\n\n## SUMMARY\n\n## P\n- 40%\n\n## RECENT\n\n**U:** go\n\n**C:** ok\n\nOUTRO');
        expect(composeHandoffDraft({ summary: null, recent: [] }, labels)).toBe('INTRO\n\nOUTRO');
    });

    it('accepts only a usable machine answer', () => {
        expect(readHandoffResponse({ type: 'error', error: 'not found' })).toBeNull();
        expect(readHandoffResponse({ type: 'success', summary: '', recent: [] })).toBeNull();
        expect(readHandoffResponse({ type: 'success', summary: 's', recent: [{ role: 'tool', text: 'x' }, { role: 'user', text: 'q' }] }))
            .toEqual({ summary: 's', recent: [{ role: 'user', text: 'q' }] });
    });

    it('falls back to the loaded messages, oldest first, skipping prompts that never ran', () => {
        expect(handoffFromMessages(loaded)).toEqual({ summary: null, recent: [{ role: 'user', text: '现在什么进展' }, { role: 'assistant', text: '还在跑' }] });
    });

    it('spawns an EMPTY codex session in the same machine/dir (no resume/fork) and prefills the summary', async () => {
        const deps = makeDeps({ type: 'success', summary: 'S', recent: [] });
        await expect(startCodexHandoff(session, labels, deps)).resolves.toEqual({ sessionId: 'new', fromMachine: true });
        expect(deps.rpc).toHaveBeenCalledWith('m1', 'codex-handoff-context', { codexThreadId: 'thread-1' });
        expect(deps.spawn).toHaveBeenCalledWith({
            source: 'codex-handoff', machineId: 'm1', directory: '/work/dir', agent: 'codex',
            approvedNewDirectoryCreation: false, parentSessionId: 'old', permissionMode: 'yolo',
        });
        expect(deps.drafts.new).toBe('INTRO\n\n## SUMMARY\n\nS\n\nOUTRO');
    });

    it('an old CLI without the RPC still gets a session, summarised from this page', async () => {
        const deps = makeDeps(new Error('Method not found'));
        await expect(startCodexHandoff(session, labels, deps)).resolves.toEqual({ sessionId: 'new', fromMachine: false });
        expect(deps.drafts.new).toContain('**U:** 现在什么进展');
    });

    it('a refused spawn is an error and leaves no draft', async () => {
        const deps = makeDeps({ type: 'success', summary: 'S', recent: [] });
        deps.spawn = vi.fn(async () => ({ type: 'error' as const, errorMessage: 'machine offline' }));
        await expect(startCodexHandoff(session, labels, deps)).rejects.toThrow('machine offline');
        expect(deps.drafts).toEqual({});
    });
});
