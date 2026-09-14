import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { importCodexThread, IMPORT_CODEX_THREAD_ENV } from './importCodexThread';

const source = '01a0637d-bfdd-7423-8da5-3eea15ca8dd7';
const fork = '01a09afe-bb1c-73c3-bd84-a16ed6729129';

function forkedThread(turns: unknown[] | undefined) {
    return { id: fork, forkedFromId: source, ...(turns ? { turns } : {}) } as any;
}

const oneTurn = [{
    id: 'turn-1',
    startedAt: 1_700_000_000,
    completedAt: 1_700_000_010,
    items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'a1', type: 'agentMessage', text: 'hi there' },
    ],
}];

function harness(forkResult: any) {
    const metadataHandlers: Array<(metadata: any) => any> = [];
    const client = {
        forkThread: vi.fn().mockResolvedValue(forkResult),
        readThread: vi.fn().mockResolvedValue({ thread: forkedThread(oneTurn) }),
    };
    const session = {
        updateMetadata: vi.fn((handler) => metadataHandlers.push(handler)),
        sendSessionEvent: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
    };
    const messageBuffer = { addMessage: vi.fn() };
    return { client, session, messageBuffer, metadataHandlers };
}

describe('importCodexThread (B-464)', () => {
    it('forks the source, records fork + origin in metadata, and replays the fork history', async () => {
        const h = harness({ threadId: fork, model: 'gpt-5.4', thread: forkedThread(oneTurn) });

        const result = await importCodexThread({
            ...h,
            threadId: source,
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });

        expect(result).toEqual({ threadId: fork, model: 'gpt-5.4', replayed: expect.any(Number) });
        expect(result.replayed).toBeGreaterThan(0);
        expect(h.client.forkThread).toHaveBeenCalledWith({
            threadId: source,
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });
        // the fork answered with turns: no second read, and never a read of the original
        expect(h.client.readThread).not.toHaveBeenCalled();
        expect(h.metadataHandlers).toHaveLength(1);
        expect(h.metadataHandlers[0]({ existing: true })).toEqual({
            existing: true,
            codexThreadId: fork,
            importedFromCodexThreadId: source,
        });
        expect(h.session.sendSessionProtocolMessage).toHaveBeenCalledTimes(result.replayed);
        expect(h.messageBuffer.addMessage).toHaveBeenCalledWith(expect.stringContaining('Imported thread'), 'status');
        expect(h.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: `Imported Codex thread ${source} (continuing as ${fork})`,
        });
    });

    it('reads the FORK (not the original) when the fork response carries no turns', async () => {
        const h = harness({ threadId: fork, model: 'gpt-5.4', thread: forkedThread(undefined) });
        const result = await importCodexThread({ ...h, threadId: source, cwd: '/tmp/project', mcpServers: {} });
        expect(h.client.readThread).toHaveBeenCalledWith({ threadId: fork, includeTurns: true });
        expect(result.replayed).toBeGreaterThan(0);
    });

    it('refuses a "fork" that is the original thread and wraps backend errors with the id', async () => {
        const same = harness({ threadId: source, model: 'gpt-5.4', thread: forkedThread(oneTurn) });
        await expect(importCodexThread({ ...same, threadId: source, cwd: '/tmp', mcpServers: {} }))
            .rejects.toThrow(/did not create an independent copy/);
        expect(same.session.updateMetadata).not.toHaveBeenCalled();

        const failing = harness(undefined);
        failing.client.forkThread.mockRejectedValue(new Error('thread not found'));
        await expect(importCodexThread({ ...failing, threadId: source, cwd: '/tmp', mcpServers: {} }))
            .rejects.toThrow(`Failed to import Codex thread ${source}: thread not found`);
        expect(failing.session.sendSessionProtocolMessage).not.toHaveBeenCalled();
    });

    it('is wired into runCodex before the fork backfill and only on a fresh spawn', () => {
        // Verified with scripts/dev/mutation-check.mjs (see PR).
        const src = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        expect(IMPORT_CODEX_THREAD_ENV).toBe('HAPPY_IMPORT_CODEX_THREAD_ID');
        expect(src).toContain('const importCodexThreadId = process.env[IMPORT_CODEX_THREAD_ENV];');
        expect(src).toContain('metadata.importedFromCodexThreadId = importCodexThreadId;');
        expect(src).toContain('if (!reconnectSessionId && !opts.resumeThreadId && importCodexThreadId) {');
        expect(src).toContain([
            '            await importCodexThread({',
            '                client,',
            '                session,',
            '                messageBuffer,',
            '                threadId: importCodexThreadId,',
            '                cwd: process.cwd(),',
            '                mcpServers,',
            '            });',
        ].join('\n'));
        expect(src.indexOf('await importCodexThread({')).toBeLessThan(src.indexOf("process.env.HAPPY_FORK_CODEX_THREAD_ID"));
    });
});
