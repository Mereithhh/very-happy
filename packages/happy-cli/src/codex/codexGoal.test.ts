import { describe, expect, it, vi } from 'vitest';
import { parseCodexGoalCommand } from '@slopus/happy-wire';
import { describeGoal, describeGoalError, describeGoalTransition, restoreCodexGoal, runCodexGoal, toAgentStateGoal, type CodexThreadGoal } from './codexGoal';

const active: CodexThreadGoal = { objective: 'ship it', status: 'active', tokenBudget: 50_000, tokensUsed: 12_345, timeUsedSeconds: 4 };

function fakeClient(opts: { version?: string | null; thread?: boolean; existing?: CodexThreadGoal | null; fail?: Error } = {}) {
    let thread = opts.thread ?? true;
    let goal = opts.existing ?? null;
    const client = {
        serverVersion: opts.version === undefined ? '0.171.0' : opts.version,
        hasActiveThread: () => thread,
        getGoal: vi.fn(async () => { if (opts.fail) throw opts.fail; return goal; }),
        setGoal: vi.fn(async (p: any) => {
            if (opts.fail) throw opts.fail;
            goal = { ...(goal ?? { objective: '', status: 'active', tokensUsed: 0, tokenBudget: null }), ...p };
            return goal;
        }),
        clearGoal: vi.fn(async () => { const had = goal !== null; goal = null; return had; }),
    };
    const deps = {
        client,
        ensureThread: vi.fn(async () => { thread = true; }),
        notify: vi.fn(),
        onGoal: vi.fn(),
    };
    return deps;
}
const run = (text: string, deps: ReturnType<typeof fakeClient>) => runCodexGoal(parseCodexGoalCommand(text)!, deps);

describe('runCodexGoal (B-953)', () => {
    it('sets a goal as active, opening the conversation when it is the first message', async () => {
        const deps = fakeClient({ thread: false });
        await expect(run('/goal ship it', deps)).resolves.toBe('set');
        expect(deps.ensureThread).toHaveBeenCalledOnce();
        expect(deps.client.setGoal).toHaveBeenCalledWith({ objective: 'ship it', status: 'active' });
        expect(deps.onGoal).toHaveBeenCalledWith(expect.objectContaining({ objective: 'ship it', status: 'active' }));
    });

    it('replaces a goal the way Codex\'s TUI does — clear, then set — keeping its budget', async () => {
        const deps = fakeClient({ existing: active });
        await run('/goal a new one', deps);
        expect(deps.client.clearGoal).toHaveBeenCalledOnce();
        expect(deps.client.setGoal).toHaveBeenCalledWith({ objective: 'a new one', status: 'active', tokenBudget: 50_000 });
    });

    it('pauses / resumes with the status alone', async () => {
        const deps = fakeClient({ existing: active });
        await expect(run('/goal pause', deps)).resolves.toBe('updated');
        expect(deps.client.setGoal).toHaveBeenLastCalledWith({ status: 'paused' });
        await run('/goal resume', deps);
        expect(deps.client.setGoal).toHaveBeenLastCalledWith({ status: 'active' });
    });

    it('sets and removes the budget', async () => {
        const deps = fakeClient({ existing: active });
        await run('/goal budget 20000', deps);
        expect(deps.client.setGoal).toHaveBeenLastCalledWith({ tokenBudget: 20_000 });
        await run('/goal budget off', deps);
        expect(deps.client.setGoal).toHaveBeenLastCalledWith({ tokenBudget: null });
    });

    it('shows the goal, or says there is none', async () => {
        const deps = fakeClient({ existing: active });
        await expect(run('/goal', deps)).resolves.toBe('shown');
        expect(deps.notify).toHaveBeenCalledWith('Goal active: ship it · 12k / 50k tokens');
        const empty = fakeClient({ thread: false });
        await expect(run('/goal', empty)).resolves.toBe('none');
        expect(empty.ensureThread).not.toHaveBeenCalled();
        expect(empty.notify.mock.calls[0][0]).toMatch(/^No goal set\. Usage: \/goal <objective>/);
    });

    it('clears; the change line comes from onGoal(null), not twice', async () => {
        const deps = fakeClient({ existing: active });
        await expect(run('/goal clear', deps)).resolves.toBe('cleared');
        expect(deps.onGoal).toHaveBeenCalledWith(null);
        expect(deps.notify).not.toHaveBeenCalled();
    });

    it('pause without a goal says so instead of failing', async () => {
        const deps = fakeClient({ existing: null });
        await expect(run('/goal pause', deps)).resolves.toBe('none');
        expect(deps.client.setGoal).not.toHaveBeenCalled();
    });

    it('on a Codex older than 0.133 says what to do and sends nothing', async () => {
        const deps = fakeClient({ version: '0.120.0' });
        await expect(run('/goal ship it', deps)).resolves.toBe('unsupported');
        expect(deps.client.setGoal).not.toHaveBeenCalled();
        expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('/goal needs Codex 0.133.0 or newer (this machine runs 0.120.0)'));
    });

    it('turns a disabled feature into the config fix', async () => {
        const deps = fakeClient({ fail: new Error('goals feature is disabled') });
        await expect(run('/goal ship it', deps)).resolves.toBe('failed');
        expect(deps.notify.mock.calls[0][0]).toMatch(/Goals are turned off in this machine's Codex config/);
    });

});

describe('goal lines', () => {
    it('describes a goal with its usage', () => {
        expect(describeGoal(active)).toBe('Goal active: ship it · 12k / 50k tokens');
        expect(describeGoal({ ...active, status: 'budgetLimited', tokenBudget: null, tokensUsed: 0 })).toBe('Goal stopped: token budget reached: ship it');
    });

    it('speaks on status / objective changes only, not token counts', () => {
        expect(describeGoalTransition(null, active)).toBe(describeGoal(active));
        expect(describeGoalTransition(active, { ...active, tokensUsed: 20_000 })).toBeNull();
        expect(describeGoalTransition(active, { ...active, status: 'complete' })).toMatch(/^Goal complete: ship it/);
        expect(describeGoalTransition(active, null)).toBe('Goal cleared');
        expect(describeGoalTransition(null, null)).toBeNull();
    });

    it('maps an unknown method to the version hint', () => {
        expect(describeGoalError(new Error('Method not found'), '0.100.0')).toMatch(/needs Codex 0\.133\.0/);
        expect(describeGoalError(new Error('boom'), '0.171.0')).toBe('Goal command failed: boom');
    });

    it('mirrors a goal into agentState', () => {
        expect(toAgentStateGoal(active, 7)).toEqual({ objective: 'ship it', status: 'active', tokenBudget: 50_000, tokensUsed: 12_345, timeUsedSeconds: 4, updatedAt: 7 });
        expect(toAgentStateGoal(null)).toBeNull();
    });
});

describe('restoreCodexGoal (resume / restart, Lead 11-22)', () => {
    it('reads the goal once and hands it on — null clears a stale strip', async () => {
        const apply = vi.fn();
        const client = { hasActiveThread: () => true, serverVersion: '0.171.0', getGoal: vi.fn(async () => active) };
        await expect(restoreCodexGoal({ client, apply })).resolves.toBe(true);
        expect(apply).toHaveBeenCalledWith(active);
        client.getGoal.mockResolvedValueOnce(null as any);
        await restoreCodexGoal({ client, apply });
        expect(apply).toHaveBeenLastCalledWith(null);
    });

    it('stays quiet without a thread, on an old Codex, or when Codex refuses', async () => {
        const apply = vi.fn();
        const getGoal = vi.fn(async () => { throw new Error('goals feature is disabled'); });
        await expect(restoreCodexGoal({ client: { hasActiveThread: () => false, serverVersion: '0.171.0', getGoal }, apply })).resolves.toBe(false);
        await expect(restoreCodexGoal({ client: { hasActiveThread: () => true, serverVersion: '0.120.0', getGoal }, apply })).resolves.toBe(false);
        expect(getGoal).not.toHaveBeenCalled();
        await expect(restoreCodexGoal({ client: { hasActiveThread: () => true, serverVersion: '0.171.0', getGoal }, apply })).resolves.toBe(false);
        expect(apply).not.toHaveBeenCalled();
    });
});
