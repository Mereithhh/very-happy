import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    markYoloAutoApproved: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.sessionRPC } }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ markYoloAutoApproved: mocks.markYoloAutoApproved }) } }));

import { resetYoloEnforcerState, runYoloEnforcement } from './yoloEnforcer';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('runYoloEnforcement (B-262 A3 execution)', () => {
    beforeEach(() => { resetYoloEnforcerState(); mocks.sessionRPC.mockReset(); mocks.markYoloAutoApproved.mockReset(); });
    afterEach(() => { vi.useRealTimers(); });

    it('rpc: one set-permission-mode covers every pending request of the session; no per-card allows', async () => {
        mocks.sessionRPC.mockResolvedValue({ mode: 'bypassPermissions' });
        runYoloEnforcement([
            { sessionId: 's1', requestId: 'r1', tool: 'Bash', action: 'rpc' },
            { sessionId: 's1', requestId: 'r2', tool: 'Read', action: 'rpc' },
        ]);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(1);
        expect(mocks.sessionRPC).toHaveBeenCalledWith('s1', 'set-permission-mode', { mode: 'bypassPermissions' }, { timeoutMs: 20_000 });
        // handled: the same ids never fire again
        runYoloEnforcement([{ sessionId: 's1', requestId: 'r1', tool: 'Bash', action: 'rpc' }]);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(1);
    });

    it('rpc failure degrades to bare per-card allows WITHOUT a mode field', async () => {
        mocks.sessionRPC.mockImplementation(async (_s: string, method: string) => {
            if (method === 'set-permission-mode') throw new Error('No active Claude query');
            return undefined;
        });
        runYoloEnforcement([{ sessionId: 's1', requestId: 'r1', tool: 'Bash', action: 'rpc' }]);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledWith('s1', 'permission', { id: 'r1', approved: true, decision: 'approved' });
        expect(mocks.markYoloAutoApproved).toHaveBeenCalledWith('s1', 'r1');
    });

    it('allow: bare permission allow per request (old wrappers), marked handled only on success', async () => {
        mocks.sessionRPC.mockRejectedValueOnce(new Error('RPC method not available')).mockResolvedValue(undefined);
        const now = { t: 1_000_000 };
        runYoloEnforcement([{ sessionId: 's2', requestId: 'r9', tool: 'Bash', action: 'allow' }], () => now.t);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(1);
        expect(mocks.markYoloAutoApproved).not.toHaveBeenCalled();
        // inside backoff window: skipped
        runYoloEnforcement([{ sessionId: 's2', requestId: 'r9', tool: 'Bash', action: 'allow' }], () => now.t + 1_000);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(1);
        // after backoff: retried and now handled
        runYoloEnforcement([{ sessionId: 's2', requestId: 'r9', tool: 'Bash', action: 'allow' }], () => now.t + 10_000);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(2);
        expect(mocks.markYoloAutoApproved).toHaveBeenCalledWith('s2', 'r9');
        runYoloEnforcement([{ sessionId: 's2', requestId: 'r9', tool: 'Bash', action: 'allow' }], () => now.t + 20_000);
        await flush();
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(2);
    });

    it('never throws into the caller even when the RPC layer explodes synchronously', async () => {
        mocks.sessionRPC.mockImplementation(() => { throw new Error('boom'); });
        expect(() => runYoloEnforcement([{ sessionId: 's3', requestId: 'r1', tool: 'Bash', action: 'allow' }])).not.toThrow();
        await flush();
    });
});
