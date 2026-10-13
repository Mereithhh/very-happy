import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ machineRPC: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: mocks.machineRPC } }));
import { worktreeCreate, worktreeInfo, worktreeSetupApprove } from './worktreeOps';

// Braces: a function returned from beforeEach is run as teardown.
beforeEach(() => { mocks.machineRPC.mockReset(); });

it('iron rule 17: an old daemon `{error:Method not found}` is unsupported, never data', async () => {
    mocks.machineRPC.mockResolvedValue({ error: 'Method not found' });
    expect(await worktreeInfo('m', '/repo')).toEqual({ ok: false, error: 'Method not found', unsupported: true });
    mocks.machineRPC.mockResolvedValue({ error: 'branch-exists: vh/a' });
    expect(await worktreeCreate('m', { path: '/repo', branch: 'vh/a', baseRef: 'main', location: '/x' })).toEqual({ ok: false, error: 'branch-exists: vh/a', unsupported: false });
    mocks.machineRPC.mockImplementation(async () => { throw new Error('RPC timeout'); });
    expect(await worktreeInfo('m', '/repo')).toMatchObject({ ok: false, error: 'RPC timeout', unsupported: false });
});

it('sends the approved hash with the exact method and params', async () => {
    mocks.machineRPC.mockResolvedValue({ tracked: true, setup: { state: 'running' } });
    const result = await worktreeSetupApprove('m', '/wt', 'abc');
    expect(result.ok).toBe(true);
    expect(mocks.machineRPC).toHaveBeenCalledWith('m', 'worktree-setup-approve', { path: '/wt', hash: 'abc' }, { timeoutMs: 30000 });
});
