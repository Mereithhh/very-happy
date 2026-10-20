import { describe, expect, it, vi } from 'vitest';
import { buildPresenceBatch, createProjectPresenceReporter } from './projectPresence';
import { ProjectsUnsupportedError } from '@/projects/client';

describe('daemon project presence', () => {
    it('batches coarse facts only (no title/doing, so the wrapper report is kept) and lists gone sessions', () => {
        const b = buildPresenceBatch([{ sessionId: 'a', flavor: 'codex', branch: 'b-1', running: true }, { sessionId: 'b', running: false }], new Set(['a', 'old']));
        expect(b.sessions).toEqual([{ sessionId: 'a', state: 'running', agent: 'codex', branch: 'b-1' }, { sessionId: 'b', state: 'idle' }]);
        expect(b.gone).toEqual(['old']);
        for (const s of b.sessions) { expect(s).not.toHaveProperty('title'); expect(s).not.toHaveProperty('doing'); }
    });
    it('one request per tick, nothing when idle, quiet on an old server', async () => {
        const presence = vi.fn(async () => ({ memberships: {} }));
        const log = vi.fn();
        let live = [{ sessionId: 'a', running: false }];
        const r = createProjectPresenceReporter({ machineId: 'm', client: { isDisabled: () => false, presence } as any, live: () => live, log, intervalMs: 1e9 });
        await r.tick();
        expect(presence).toHaveBeenCalledTimes(1);
        live = [];
        await r.tick();
        expect(presence).toHaveBeenLastCalledWith('m', [], ['a']);
        await r.tick();
        expect(presence).toHaveBeenCalledTimes(2);
        presence.mockRejectedValueOnce(new ProjectsUnsupportedError());
        live = [{ sessionId: 'z', running: true }];
        await r.tick();
        expect(log).not.toHaveBeenCalled();
        r.stop();
    });
});
