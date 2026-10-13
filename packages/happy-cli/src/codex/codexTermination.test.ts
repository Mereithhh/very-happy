import { describe, expect, it, vi } from 'vitest';
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
});
