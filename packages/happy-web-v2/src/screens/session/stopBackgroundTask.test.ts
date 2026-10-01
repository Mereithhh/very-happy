import { describe, expect, it, vi } from 'vitest';

const calls: Array<{ request: Record<string, unknown>; opts?: { timeoutMs?: number } }> = [];
let replies: unknown[] = [];
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { sessionRPC: async (_s: string, _m: string, request: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        calls.push({ request, opts });
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
    } },
}));
const { stopBackgroundTask } = await import('./claudeRuntimeControl');
const noSleep = async () => {};

describe('B-527 stopping a background task reports the outcome', () => {
    it('waits for the operation to complete, with a short RPC timeout', async () => {
        calls.length = 0;
        replies = [{ operationId: 'op1' }, { status: 'running' }, { status: 'completed' }];
        await stopBackgroundTask('s', 't1', { sleep: noSleep });
        expect(calls[0]).toMatchObject({ request: { action: 'stop-task', taskId: 't1' }, opts: { timeoutMs: 15_000 } });
        expect(calls.slice(1).map((c) => c.request.action)).toEqual(['operation', 'operation']);
    });
    it('surfaces a refused or failed stop', async () => {
        replies = [{ error: 'Unknown task in this query' }];
        await expect(stopBackgroundTask('s', 't', { sleep: noSleep })).rejects.toThrow('Unknown task');
        replies = [{ operationId: 'op2' }, { status: 'failed', error: 'boom' }];
        await expect(stopBackgroundTask('s', 't', { sleep: noSleep })).rejects.toThrow('boom');
    });
    it('an unreachable runner fails fast instead of hanging', async () => {
        replies = [new Error('operation has timed out')];
        await expect(stopBackgroundTask('s', 't', { sleep: noSleep, timeoutMs: 50 })).rejects.toThrow('timed out');
    });
});
