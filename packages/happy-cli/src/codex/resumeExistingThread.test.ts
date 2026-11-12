import { describe, expect, it, vi } from 'vitest';

import { isThreadProviderMismatch, resumeExistingThread } from './resumeExistingThread';

describe('resumeExistingThread', () => {
    it('resumes the thread and updates session metadata', async () => {
        const client = {
            forkThread: vi.fn(),
            resumeThread: vi.fn().mockResolvedValue({
                threadId: '019ccca2-1a77-7481-9873-de72f3464372',
                model: 'gpt-5.4',
            }),
        };
        const metadataHandlers: Array<(metadata: any) => any> = [];
        const session = {
            updateMetadata: vi.fn((handler) => metadataHandlers.push(handler)),
            sendSessionEvent: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer,
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });

        expect(result).toEqual({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            model: 'gpt-5.4',
        });
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });
        expect(metadataHandlers).toHaveLength(1);
        expect(metadataHandlers[0]({ existing: true })).toEqual({
            existing: true,
            codexThreadId: '019ccca2-1a77-7481-9873-de72f3464372',
        });
        expect(messageBuffer.addMessage).toHaveBeenCalledWith(expect.stringContaining('Resumed thread'), 'status');
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Resumed Codex thread 019ccca2-1a77-7481-9873-de72f3464372',
        });
    });

    it('B-931: announce=false (an automatic restart) keeps the chat free of the resume line', async () => {
        const client = { forkThread: vi.fn(), resumeThread: vi.fn().mockResolvedValue({ threadId: 't-1', model: 'gpt-5.4' }) };
        const session = { updateMetadata: vi.fn(), sendSessionEvent: vi.fn() };
        const messageBuffer = { addMessage: vi.fn() };
        await resumeExistingThread({ client, session, messageBuffer, threadId: 't-1', cwd: '/tmp/project', mcpServers: {}, announce: false });
        expect(session.sendSessionEvent).not.toHaveBeenCalled();
        expect(session.updateMetadata).toHaveBeenCalledTimes(1);
    });

    it('wraps backend resume errors with the thread ID', async () => {
        const client = {
            resumeThread: vi.fn().mockRejectedValue(new Error('thread not found')),
            forkThread: vi.fn(),
        };
        const session = {
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        await expect(
            resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: 'thread-404',
                cwd: '/tmp/project',
                mcpServers: {},
            }),
        ).rejects.toThrow('Codex error: could not resume this conversation (thread thread-404): thread not found');
        // B-934b: said in the transcript, not only in the wrapper's exit.
        expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-resume-failed', message: expect.stringMatching(/^Codex error: .*thread not found/) }));
        expect(client.forkThread).not.toHaveBeenCalled();
    });

    describe('B-934b: thread on another provider (Codex ≥0.167)', () => {
        const mismatches = [
            'thread/resume: This chat uses model provider “vh-team”, which is no longer configured. Restore this provider’s configuration to continue. (code=-32600)',
            'thread/resume: This chat uses llmhub, but your current provider is vh-team. Switch to llmhub to continue. (code=-32600)',
        ];
        const setup = (fork: () => Promise<{ threadId: string; model: string }>) => {
            const metadata: Array<(m: any) => any> = [];
            return {
                client: { resumeThread: vi.fn().mockRejectedValue(new Error('x')), forkThread: vi.fn(fork) },
                session: { updateMetadata: vi.fn((h) => metadata.push(h)), sendSessionEvent: vi.fn() },
                messageBuffer: { addMessage: vi.fn() },
                metadata,
            };
        };

        it.each(mismatches)('recognises %s', (message) => {
            expect(isThreadProviderMismatch(message)).toBe(true);
        });

        it('does not take other errors for a provider change', () => {
            expect(isThreadProviderMismatch('thread/resume: thread not found (code=-32600)')).toBe(false);
            expect(isThreadProviderMismatch('This chat uses too many tokens')).toBe(false);
        });

        it.each(mismatches)('continues in a fork with the same history: %s', async (message) => {
            const t = setup(async () => ({ threadId: 'fork-1', model: 'm2' }));
            t.client.resumeThread.mockRejectedValue(new Error(message));
            const result = await resumeExistingThread({ ...t, threadId: 'old-1', cwd: '/w', mcpServers: {}, model: 'm2', accountLabel: 'Hub' });
            expect(result).toEqual({ threadId: 'fork-1', model: 'm2', forkedFrom: 'old-1' });
            expect(t.client.forkThread).toHaveBeenCalledWith({ threadId: 'old-1', cwd: '/w', mcpServers: {}, model: 'm2', excludeTurns: true });
            expect(t.metadata[0]({ a: 1 })).toEqual({ a: 1, codexThreadId: 'fork-1', codexThreadForkedFrom: 'old-1' });
            expect(t.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-provider-switch', message: expect.stringContaining('account "Hub"') }));
        });

        it('B-931 × B-934b: announce=false hides only the plain resume line; the switch notice and Codex errors still show', async () => {
            const t = setup(async () => ({ threadId: 'fork-q', model: 'm' }));
            t.client.resumeThread.mockRejectedValue(new Error(mismatches[0]));
            await resumeExistingThread({ ...t, threadId: 'old-q', cwd: '/w', mcpServers: {}, announce: false });
            expect(t.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-provider-switch' }));

            const f = setup(async () => { throw new Error('thread/fork: boom'); });
            f.client.resumeThread.mockRejectedValue(new Error(mismatches[0]));
            await expect(resumeExistingThread({ ...f, threadId: 'old-r', cwd: '/w', mcpServers: {}, announce: false })).rejects.toThrow(/^Codex error:/);
            expect(f.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-provider-switch-failed' }));

            const e = setup(async () => ({ threadId: 'x', model: 'm' }));
            e.client.resumeThread.mockRejectedValue(new Error('thread not found'));
            await expect(resumeExistingThread({ ...e, threadId: 'old-s', cwd: '/w', mcpServers: {}, announce: false })).rejects.toThrow(/^Codex error:/);
            expect(e.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-resume-failed' }));
        });

        it('names the machine login when switching back to it', async () => {
            const t = setup(async () => ({ threadId: 'fork-2', model: 'm' }));
            t.client.resumeThread.mockRejectedValue(new Error(mismatches[0]));
            await resumeExistingThread({ ...t, threadId: 'old-2', cwd: '/w', mcpServers: {} });
            expect(t.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("this machine's Codex login") }));
        });

        it('a failed fork is a visible Codex error with the way out, never a silent exit', async () => {
            const t = setup(async () => { throw new Error('thread/fork: boom'); });
            t.client.resumeThread.mockRejectedValue(new Error(mismatches[1]));
            await expect(resumeExistingThread({ ...t, threadId: 'old-3', cwd: '/w', mcpServers: {}, accountLabel: 'Hub' })).rejects.toThrow(/^Codex error: this conversation cannot continue on account "Hub"/);
            expect(t.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex-provider-switch-failed', message: expect.stringMatching(/^Codex error: .*boom.*Switch back to the previous account/) }));
            expect(t.metadata).toHaveLength(0);
        });

        it('a fork that returns the same thread is refused', async () => {
            const t = setup(async () => ({ threadId: 'old-4', model: 'm' }));
            t.client.resumeThread.mockRejectedValue(new Error(mismatches[1]));
            await expect(resumeExistingThread({ ...t, threadId: 'old-4', cwd: '/w', mcpServers: {} })).rejects.toThrow(/did not create a new thread/);
        });
    });
});
