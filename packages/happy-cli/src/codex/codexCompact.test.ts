import { describe, expect, it, vi } from 'vitest';
import { runCodexCompact } from './codexCompact';

function client(result: { aborted: boolean; failed: boolean } | Error, hasThread = true) {
    return {
        hasActiveThread: () => hasThread,
        compactThreadAndWait: vi.fn(async () => {
            if (result instanceof Error) throw result;
            return result;
        }),
    };
}

describe('runCodexCompact', () => {
    it('compacts through the app-server and marks start and end like Claude does', async () => {
        const c = client({ aborted: false, failed: false });
        const notify = vi.fn();
        await expect(runCodexCompact('/compact', { client: c, notify })).resolves.toBe('completed');
        expect(c.compactThreadAndWait).toHaveBeenCalledOnce();
        expect(notify.mock.calls.map(([t]) => t)).toEqual(['Compaction started', 'Compaction completed']);
    });

    it('says instructions are not used — Codex compaction takes none', async () => {
        const notify = vi.fn();
        await runCodexCompact('/compact 保留测试结论', { client: client({ aborted: false, failed: false }), notify });
        expect(notify.mock.calls[0][0]).toMatch(/does not take compaction instructions/);
    });

    it('reports a failed or refused compaction', async () => {
        const notify = vi.fn();
        await expect(runCodexCompact('/compact', { client: client({ aborted: false, failed: true }), notify })).resolves.toBe('failed');
        expect(notify).toHaveBeenLastCalledWith('Compaction failed: Codex could not compact the conversation');
        await expect(runCodexCompact('/compact', { client: client(new Error('thread not found: x')), notify })).resolves.toBe('failed');
        expect(notify).toHaveBeenLastCalledWith('Compaction failed: thread not found: x');
    });

    it('leaves an interrupted compaction without an end line', async () => {
        const notify = vi.fn();
        await expect(runCodexCompact('/compact', { client: client({ aborted: true, failed: false }), notify })).resolves.toBe('aborted');
        expect(notify.mock.calls.map(([t]) => t)).toEqual(['Compaction started']);
    });

    it('does not start anything before the session has a Codex thread', async () => {
        const c = client({ aborted: false, failed: false }, false);
        const notify = vi.fn();
        await expect(runCodexCompact('/compact', { client: c, notify })).resolves.toBe('no-thread');
        expect(c.compactThreadAndWait).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith('Compaction failed: there is no conversation to compact yet');
    });
});
