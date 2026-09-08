import { describe, expect, it, vi } from 'vitest';
import { createRewindBranch } from './rewindOperation';
import { appendMessageQuote, getRewindTarget, rewindPermissionMode, type RewindTarget } from './messageActionsModel';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';
const target: RewindTarget = { source: { kind: 'claude', sessionId: 'parent', machineId: 'machine', directory: '/repo', claudeSessionId: 'claude-id' }, messageId: 'message', pointId: 'point' };
const message = { kind: 'user-text', id: 'message', text: 'hello', seq: 1, claudeUuid: 'point' } as UserTextMessage;
const session = { id: 'parent', metadata: { machineId: 'machine', path: '/repo', claudeSessionId: 'claude-id', flavor: 'claude' } } as Session;
describe('edit and rerun', () => {
    it('uses a separate before RPC and preserves lineage and permission intent', async () => {
        const rpc = vi.fn().mockResolvedValue({ type: 'success', newClaudeSessionId: 'new-id' });
        const spawn = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'branch' });
        expect(await createRewindBranch(target, 'default', { rpc, spawn, rememberMode: vi.fn() })).toBe('branch');
        expect(rpc).toHaveBeenCalledWith('machine', 'claude-rewind-before-message', { directory: '/repo', claudeSessionId: 'claude-id', cutBeforeUuid: 'point' });
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ resumeClaudeSessionId: 'new-id', permissionMode: 'default', parentSessionId: 'parent', forkedFromMessageId: 'message' }));
    });
    it('starts fresh for the first prompt without resuming any old context', async () => {
        const spawn = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'branch' });
        await createRewindBranch(target, undefined, { rpc: vi.fn().mockResolvedValue({ type: 'success', startFresh: true }), spawn, rememberMode: vi.fn() });
        expect(spawn.mock.calls[0][0]).not.toHaveProperty('resumeClaudeSessionId');
        expect(spawn.mock.calls[0][0]).not.toHaveProperty('resumeCodexThreadId');
    });
    it.each([{ error: 'old daemon' }, { type: 'success', error: 'failed', newClaudeSessionId: 'bad' }, { type: 'success' }, null])('never spawns after an error or malformed resolved RPC %j', async (response) => {
        const spawn = vi.fn();
        await expect(createRewindBranch(target, undefined, { rpc: vi.fn().mockResolvedValue(response), spawn, rememberMode: vi.fn() })).rejects.toThrow();
        expect(spawn).not.toHaveBeenCalled();
    });
    it('uses Codex exact item id without the old duplicate RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ type: 'success', newCodexThreadId: 'new-thread' });
        const spawn = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'branch' });
        await createRewindBranch({ ...target, source: { kind: 'codex', sessionId: 'parent', machineId: 'machine', directory: '/repo', codexThreadId: 'thread' } }, undefined, { rpc, spawn, rememberMode: vi.fn() });
        expect(rpc.mock.calls[0][1]).toBe('codex-rewind-before-message');
        expect(spawn.mock.calls[0][0]).toMatchObject({ agent: 'codex', resumeCodexThreadId: 'new-thread' });
    });
    it('does not guess missing identifiers from text or accept stale Claude IDs on pi', () => {
        expect(getRewindTarget(session, { ...message, claudeUuid: undefined }, false, false)).toBe('missingPoint');
        expect(getRewindTarget({ ...session, metadata: { ...session.metadata!, flavor: 'pi' } }, message, false, false)).toBe('unsupported');
        expect(getRewindTarget(session, message, true, false)).toBe('attachments');
        expect(getRewindTarget(session, message, false, true)).toBe('running');
        expect(getRewindTarget(session, { ...message, inputState: 'queued' }, false, false)).toBe('pending');
    });
    it('preserves Codex read-only and safe-yolo without Claude normalization', () => {
        expect(rewindPermissionMode('codex', 'read-only')).toBe('read-only');
        expect(rewindPermissionMode('codex', 'safe-yolo')).toBe('safe-yolo');
        expect(rewindPermissionMode('codex', null)).toBe('read-only');
        expect(rewindPermissionMode('claude', 'plan')).toBe('plan');
    });
    it('quotes all lines and retains an existing draft', () => {
        expect(appendMessageQuote('Existing draft', 'a\n\nb')).toBe('Existing draft\n\n> a\n> \n> b\n\n');
        expect(appendMessageQuote('', 'a')).toBe('> a\n\n');
    });
});
