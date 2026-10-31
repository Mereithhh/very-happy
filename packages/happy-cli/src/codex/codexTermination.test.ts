import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settleCodexSession } from './codexTermination';
import type { Metadata } from '@/api/types';

function session() {
    let metadata = { path: '/p', host: 'h', lifecycleState: 'running' } as Metadata;
    const order: string[] = [];
    return {
        order,
        get metadata() { return metadata; },
        sessionId: 's1',
        updateMetadata: vi.fn((h: (m: Metadata) => Metadata) => { order.push('stamp'); metadata = h(metadata); }),
        sendSessionDeath: vi.fn(() => { order.push('session-end'); }),
        flush: vi.fn(async () => { order.push('flush'); }),
        close: vi.fn(async () => { order.push('close'); }),
    };
}

describe('B-587 / AGENTS 7: Codex exit by intent', () => {
    it('offline (SIGTERM / SIGINT): session-end + /deactivate, NO archived stamp', async () => {
        const s = session();
        const deactivate = vi.fn(async () => true);
        await settleCodexSession(s, 'offline', deactivate);
        expect(s.metadata.lifecycleState).toBe('running');
        expect(s.updateMetadata).not.toHaveBeenCalled();
        expect(deactivate).toHaveBeenCalledWith('s1');
        expect(s.order).toEqual(['session-end', 'flush', 'close']);
    });
    it('archive (user kill / archived event): stamps archived, never deactivates', async () => {
        const s = session();
        const deactivate = vi.fn(async () => true);
        await settleCodexSession(s, 'archive', deactivate);
        expect(s.metadata).toMatchObject({ lifecycleState: 'archived', archivedBy: 'cli' });
        expect(deactivate).not.toHaveBeenCalled();
    });
    it('a failing deactivate still closes the session', async () => {
        const s = session();
        await settleCodexSession(s, 'offline', async () => { throw new Error('down'); });
        expect(s.close).toHaveBeenCalled();
    });
    it('B-679: offline with an exit cursor stamps it (awaited) before session-end; archive never does', async () => {
        const s = session();
        const order = s.order;
        const updateMetadataAndWait = vi.fn(async (h: (m: Metadata) => Metadata) => { order.push('cursor'); (s as any)._m = h(s.metadata); return true; });
        const cursor = { at: 1, seq: 21, v: 1 as const };
        await settleCodexSession({ ...s, updateMetadataAndWait, sessionId: 's1' }, 'offline', async () => true, () => {}, cursor);
        expect(order).toEqual(['cursor', 'session-end', 'flush', 'close']);
        expect((s as any)._m.exitCursor).toEqual(cursor);
        const a = session();
        const wait = vi.fn(async () => true);
        await settleCodexSession({ ...a, updateMetadataAndWait: wait, sessionId: 's1' }, 'archive', async () => true, () => {}, cursor);
        expect(wait).not.toHaveBeenCalled();
    });
    it('B-679: runCodex freezes inbound with the cursor before aborting and hands it to settle', () => {
        const src = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8').replace(/\/\/.*$/gm, '');
        expect(src).toContain("const exitCursor = intent === 'offline' && session ? exitCursorStamp(session.messageCursor, Date.now()) : undefined;\n        if (exitCursor) session.freezeInbound();\n");
        // B-854 tombstones the held/queued input between the freeze and the abort.
        const freeze = src.indexOf('if (exitCursor) session.freezeInbound();');
        expect(freeze).toBeGreaterThan(-1);
        expect(src.indexOf("await handleAbort('kill');", freeze)).toBeGreaterThan(freeze);
        expect(src).toContain('(m, e) => logger.debug(m, safeCodexErrorMetadata(e)), exitCursor);');
        expect(src).toContain('void session.cancelUndeliveredQueuedInputs(reconnectReplay ? { maxSeq: reconnectReplay.seq } : undefined);');
    });
});
