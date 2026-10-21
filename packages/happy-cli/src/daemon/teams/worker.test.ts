import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TeamOperation, TeamState } from '@slopus/happy-wire';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), send: vi.fn(), key: vi.fn(), persisted: vi.fn(), prepare: vi.fn(), resolve: vi.fn(), remove: vi.fn(), archive: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({ get: mocks.get, post: mocks.post }), isAxiosError: () => false } }));
vi.mock('@/configuration', () => ({ configuration: { happyHomeDir: '', serverUrl: '' } }));
vi.mock('@/persistence', () => ({ readPersistedSessions: mocks.persisted }));
vi.mock('@/commands/sessionMessage', () => ({ sendUserMessage: mocks.send, waitForSessionKey: mocks.key }));
vi.mock('@/sessions/sessionOps', () => ({ archiveSession: mocks.archive }));
vi.mock('./worktree', () => ({ prepareTeamWorktree: mocks.prepare, resolveTeamRepository: mocks.resolve, removeTeamWorktree: mocks.remove }));
import { createTeamWorker } from './worker';
import { readReceipt, writeReceipt } from './journal';

let home: string;
let workers: ReturnType<typeof createTeamWorker>[] = [];
const op = (): TeamOperation => ({ id: 'op1', teamId: 'team1', machineId: 'machine1', taskId: 'task1', botId: 'bot1', attemptId: 'attempt1', generation: 1, type: 'spawn', status: 'pending', claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/repo', assistant: 'codex', prompt: 'A bounded task', createdAt: 1 });
const team = (operations: TeamOperation[]): TeamState => ({ id: 'team1', name: 'Team', machineId: 'machine1', version: 1, bots: [{ id: 'bot1', name: 'Worker', sessionId: 'session1', generation: 1, root: false, managed: true, assistant: 'codex', directory: '/repo' }], tasks: [{ id: 'task1', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: null, assigneeBotId: 'bot1', status: 'queued', attempts: [], currentAttemptId: 'attempt1', cleanup: 'none' }], messages: [], operations, createdAt: 1 });
const spawn = vi.fn();
const stopAndWait = vi.fn();
function start(live: () => boolean = () => false) {
    const worker = createTeamWorker({ home, serverUrl: 'http://127.0.0.1:1', machineId: 'machine1', token: 'test', spawn, stopAndWait, live, log: () => {} });
    workers.push(worker);
    return worker;
}
async function settled(worker: ReturnType<typeof createTeamWorker>) {
    for (let i = 0; worker.busy && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    expect(worker.busy).toBe(false);
}
function setup(operation: TeamOperation) {
    const state = team([operation]);
    mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [operation], teams: [state] } : { team: state } }));
    mocks.post.mockImplementation(async (path: string, request: { action: { type: string } }) => path.endsWith('/schedules/tick') ? { data: { fired: 0, errors: [] } } : ({ data: { team: state, operation: { ...operation, status: 'claimed', claimId: 'claim1' }, ...(request.action?.type === 'claim-operation' ? { credential: { botId: 'bot1', token: 'scoped-test' } } : {}) } }));
}
beforeEach(() => {
    vi.clearAllMocks();
    const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'worker-'));
    mocks.persisted.mockReturnValue({});
    stopAndWait.mockReset().mockResolvedValue(undefined);
    mocks.prepare.mockResolvedValue({ directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
    mocks.resolve.mockImplementation(async (_home: string, repository: string) => repository);
    mocks.key.mockResolvedValue(new Uint8Array(32));
    mocks.send.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    spawn.mockReset().mockResolvedValue({ type: 'success', sessionId: 'session1' });
});
afterEach(() => { workers.forEach(w => w.stop()); workers = []; rmSync(home, { recursive: true, force: true }); });

describe('daemon team effect recovery', () => {
    it('settles archived teams without deleting retained worktrees', async () => {
        const operation = {...op(), type:'stop' as const, sessionId:'session1'};
        setup(operation);
        const original = mocks.get.getMockImplementation()!;
        mocks.get.mockImplementation(async (...args) => {
            const result = await original(...args);
            if (result.data.team) result.data.team.archivedAt = 10;
            return result;
        });
        const worker = start(); await settled(worker);
        expect(stopAndWait).toHaveBeenCalledWith('session1');
        expect(mocks.archive).toHaveBeenCalledWith('session1');
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
        expect(mocks.get).toHaveBeenCalledWith('/v1/teams/operations', expect.objectContaining({params:expect.objectContaining({teamArchiveVersion:1})}));
    });
    it('injects the official skill and selected model into the first managed task message', async () => {
        setup({ ...op(), model: 'provider/model', teamLaunchVersion: 1 });
        const worker = start(); await settled(worker);
        expect(mocks.send).toHaveBeenCalledWith('session1', expect.anything(), expect.stringContaining('name: very-happy-teams'), 'teams', expect.objectContaining({ model: 'provider/model', localId: 'teams-initial-op1' }));
        expect(mocks.send.mock.calls[0][2]).toContain('You are a team member');
        expect(mocks.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: expect.objectContaining({ type: 'claim-operation', teamLaunchVersion: 1 }) }));
    });
    it('recovers a pre-upgrade prepared receipt using the original claim payload', async () => {
        const operation = { ...op(), status: 'claimed' as const, claimId: 'claim1' };
        setup(operation);
        writeReceipt(home, { operationId: operation.id, teamId: operation.teamId, claimId: 'claim1', phase: 'prepared' });
        const original = mocks.post.getMockImplementation()!;
        mocks.post.mockImplementation(async (...args) => {
            const request = args[1];
            if (request.action?.type === 'claim-operation') {
                expect(request).toEqual({ requestId: 'claim-op1', action: { type: 'claim-operation', operationId: 'op1', machineId: 'machine1' } });
                if ('teamLaunchVersion' in request.action) throw new Error('request_id_conflict');
            }
            return original(...args);
        });
        const worker = start(); await settled(worker);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
        expect(mocks.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: expect.objectContaining({ type: 'complete-operation', workingDirectory: '/isolated' }) }));
    });
    it('does not launch a second wrapper after spawn succeeded but initial message failed', async () => {
        setup(op());
        mocks.send.mockRejectedValueOnce(new Error('network unavailable'));
        const worker = start(); await settled(worker);
        expect(readReceipt(home, 'op1')?.phase).toBe('spawned');
        await worker.tick();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(mocks.send).toHaveBeenCalledTimes(2);
        expect(mocks.send.mock.calls.map(c => c[4].localId)).toEqual(['teams-initial-op1', 'teams-initial-op1']);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
    });
    it('does not resend the initial prompt when only completion acknowledgement was lost', async () => {
        setup(op());
        const original = mocks.post.getMockImplementation()!;
        let failed = false;
        mocks.post.mockImplementation(async (...args) => {
            if (args[1].action?.type === 'complete-operation' && !failed) { failed = true; throw new Error('lost ACK'); }
            return original(...args);
        });
        const worker = start(); await settled(worker);
        expect(readReceipt(home, 'op1')?.phase).toBe('delivered');
        await worker.tick();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
    });
    it('keeps uncertain spawn fenced until one persisted wrapper proves its identity', async () => {
        setup({ ...op(), status: 'claimed', claimId: 'claim1' });
        writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim1', phase: 'spawning' });
        const worker = start(); await settled(worker);
        expect(spawn).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(mocks.post.mock.calls.some(c => c[1].action?.unknown === true)).toBe(true);
        mocks.persisted.mockReturnValue({ session1: { metadata: { teamOperationId: 'op1' } } });
        await worker.tick();
        expect(spawn).not.toHaveBeenCalled();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
    });
    // B-689: 10-21 a worker exited 1 at startup (ECONNRESET under load) and the
    // launch stayed "needs attention" forever — every spawn error was treated as
    // an uncertain spawn. A wrapper confirmed gone is a definite failure.
    it('relaunches with backoff after a confirmed startup exit, then waits for the owner', async () => {
        let now = 1_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const operation = op(); setup(operation);
            const exited = { type: 'error', errorMessage: 'Agent process exited during startup (code 1): ECONNRESET', startupExit: { exited: true, code: 1, signal: null } };
            spawn.mockResolvedValue(exited);
            const worker = start(); await settled(worker);
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(readReceipt(home, 'op1')).toMatchObject({ phase: 'prepared', spawnFailures: 1, retryAt: now + 10_000, directory: '/isolated' });
            const failure = mocks.post.mock.calls.find(c => c[1].action?.type === 'fail-operation');
            expect(failure?.[1].action.unknown).toBeUndefined();
            expect(failure?.[1].action.error).toContain('exited during startup (code 1): ECONNRESET');
            expect(failure?.[1].action.error).toContain('automatic retry 2/5 in 10s');
            await worker.tick();
            expect(spawn).toHaveBeenCalledTimes(1); // backoff not elapsed
            for (const delay of [10_000, 30_000, 60_000, 120_000]) { now += delay; await worker.tick(); }
            expect(spawn).toHaveBeenCalledTimes(5);
            expect(readReceipt(home, 'op1')).toMatchObject({ phase: 'prepared', spawnFailures: 5 });
            expect(readReceipt(home, 'op1')?.retryAt).toBeUndefined();
            expect(mocks.post.mock.calls.filter(c => c[1].action?.type === 'fail-operation').pop()?.[1].action.error).toContain('automatic retries exhausted after 5 attempts');
            now += 3_600_000; await worker.tick();
            expect(spawn).toHaveBeenCalledTimes(5); // budget spent: only the owner restarts it
            // Owner「重试启动」: retry-operation stamps retryRequestedAt.
            spawn.mockResolvedValue({ type: 'success', sessionId: 'session1' });
            const retried = { ...operation, status: 'failed' as const, claimId: 'claim1', retryRequestedAt: 42 };
            setup(retried);
            await worker.tick();
            expect(spawn).toHaveBeenCalledTimes(6);
            expect(readReceipt(home, 'op1')).toMatchObject({ phase: 'completed', retryConsumed: 42 });
        } finally { clock.mockRestore(); }
    });
    it('B-706: a reactivated bot launches from the source behind its removed worktree; an unusable one backs off with the cause', async () => {
        let now = 1_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            // The old launch's receipt records where its worktree came from.
            writeReceipt(home, { operationId: 'old-op', teamId: 'team1', claimId: 'old-claim', phase: 'completed', directory: join(home, 'teams', 'worktrees', 'old-op'), repository: '/repo', branch: 'codex/team-old-op' });
            const operation = { ...op(), directory: join(home, 'teams', 'worktrees', 'old-op') }; setup(operation);
            mocks.resolve.mockImplementationOnce(async (_home: string, repository: string, sourceOf: (id: string) => string | undefined) => repository.endsWith('/old-op') ? sourceOf('old-op')! : repository);
            const worker = start(); await settled(worker);
            expect(mocks.prepare).toHaveBeenCalledWith(home, '/repo', 'op1');
            expect(spawn).toHaveBeenCalledTimes(1);

            // Nothing to fall back to: a definite preflight failure, reported once per attempt with backoff.
            rmSync(join(home, 'teams', 'effects'), { recursive: true, force: true });
            spawn.mockClear(); mocks.post.mockClear();
            mocks.resolve.mockRejectedValue(new Error('Team repository is unavailable: /gone is missing or not a Git checkout. Restore the folder or delegate with an existing repository, then choose Retry launch.'));
            setup({ ...op(), directory: '/gone' });
            await worker.tick();
            expect(spawn).not.toHaveBeenCalled();
            expect(readReceipt(home, 'op1')).toMatchObject({ phase: 'prepared', spawnFailures: 1, retryAt: now + 10_000 });
            const failures = () => mocks.post.mock.calls.filter(c => c[1].action?.type === 'fail-operation');
            expect(failures()[0][1].action.error).toContain('Team repository is unavailable: /gone');
            expect(failures()[0][1].action.error).toContain('automatic retry 2/5 in 10s');
            await worker.tick(); await worker.tick();
            expect(failures()).toHaveLength(1); // no longer re-failed on every poll
            for (const delay of [10_000, 30_000, 60_000, 120_000]) { now += delay; await worker.tick(); }
            expect(failures().pop()?.[1].action.error).toContain('automatic retries exhausted after 5 attempts');
            now += 3_600_000; await worker.tick();
            expect(failures()).toHaveLength(5);
            // Owner「重试启动」 after fixing the folder (the server also re-reads the source repository).
            mocks.resolve.mockImplementation(async (_home: string, repository: string) => repository);
            setup({ ...op(), directory: '/repo', status: 'failed', claimId: 'claim1', retryRequestedAt: 42 });
            await worker.tick();
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(readReceipt(home, 'op1')).toMatchObject({ phase: 'completed', retryConsumed: 42 });
        } finally { clock.mockRestore(); }
    });
    it('still fences a spawn error whose wrapper is not confirmed gone', async () => {
        setup(op());
        spawn.mockResolvedValue({ type: 'error', errorMessage: 'Agent process did not report its session within 15s and could not be confirmed stopped', startupExit: { exited: false, code: null, signal: null, timedOut: true } });
        const worker = start(); await settled(worker);
        expect(readReceipt(home, 'op1')?.phase).toBe('spawning');
        expect(mocks.post.mock.calls.some(c => c[1].action?.type === 'fail-operation' && c[1].action.unknown === true)).toBe(true);
        await worker.tick();
        expect(spawn).toHaveBeenCalledTimes(1);
    });
    it('relaunches an uncertain spawn only on an owner retry and only without a reported wrapper', async () => {
        const uncertain = { ...op(), status: 'unknown' as const, claimId: 'claim1', retryRequestedAt: 7 };
        setup(uncertain);
        writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim1', phase: 'spawning', directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
        mocks.persisted.mockReturnValue({ session1: { metadata: { teamOperationId: 'op1' } } });
        const worker = start(); await settled(worker);
        expect(spawn).not.toHaveBeenCalled(); // a wrapper that reported for this op wins
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');

        rmSync(join(home, 'teams'), { recursive: true, force: true });
        mocks.persisted.mockReturnValue({});
        writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim1', phase: 'spawning' });
        setup({ ...uncertain, retryRequestedAt: undefined });
        await worker.tick();
        expect(spawn).not.toHaveBeenCalled(); // no owner retry: stays fenced
        setup(uncertain);
        await worker.tick();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(readReceipt(home, 'op1')).toMatchObject({ phase: 'completed', retryConsumed: 7 });
    });
    it('never claims a previously claimed operation when its local effect receipt is absent', async () => {
        setup({ ...op(), status: 'claimed', claimId: 'claim1' });
        const worker = start(); await settled(worker);
        expect(mocks.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: expect.objectContaining({ type: 'fail-operation', unknown: true }) }));
        expect(spawn).not.toHaveBeenCalled();
    });
    it('does not start a task cancelled between claim and execution', async () => {
        const operation = op(); setup(operation);
        const state = team([operation]); state.tasks[0].status = 'cancelled';
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [operation], teams: [state] } : { team: state } }));
        const worker = start(); await settled(worker);
        expect(spawn).not.toHaveBeenCalled();
        expect(mocks.post.mock.calls.some(c => c[1].action?.error === 'task_closed_before_spawn')).toBe(true);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
    });
    it('withholds the initial task if cancellation happens while the wrapper starts', async () => {
        const operation = op(); setup(operation); const state = team([operation]);
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [operation], teams: [state] } : { team: state } }));
        spawn.mockImplementationOnce(async () => { state.tasks[0].status = 'cancelled'; return { type: 'success', sessionId: 'session1' }; });
        const worker = start(); await settled(worker);
        expect(mocks.send).not.toHaveBeenCalled();
        expect(stopAndWait).toHaveBeenCalledWith('session1');
    });
    it('does not archive or remove resources without proof the wrapper stopped', async () => {
        setup({ ...op(), id: 'stop1', type: 'stop', sessionId: 'session1' });
        stopAndWait.mockRejectedValueOnce(new Error('Orphan wrapper still running'));
        const worker = start(); await settled(worker);
        expect(mocks.archive).not.toHaveBeenCalled();
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(readReceipt(home, 'stop1')?.phase).not.toBe('completed');
    });
    it('cleans the original worktree after return created a newer attempt on the same wrapper', async () => {
        const origin = { ...op(), status: 'completed' as const, sessionId: 'session1' };
        const cleanup = { ...op(), id: 'stop2', type: 'stop' as const, sessionId: 'session1', attemptId: 'attempt2' };
        setup(cleanup); const state = team([origin, cleanup]);
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [cleanup], teams: [state] } : { team: state } }));
        writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim0', phase: 'completed', sessionId: 'session1', directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
        const worker = start(); await settled(worker);
        expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'op1', directory: '/isolated' }));
        expect(readReceipt(home, 'stop2')?.phase).toBe('completed');
    });
    it('preserves failed cleanup for another pass and never marks it completed', async () => {
        const spawnOperation = { ...op(), status: 'completed' as const, sessionId: 'session1' };
        const cleanup = { ...op(), id: 'stop1', type: 'stop' as const, sessionId: 'session1' };
        setup(cleanup);
        const state = team([spawnOperation, cleanup]);
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [cleanup], teams: [state] } : { team: state } }));
        writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim0', phase: 'completed', directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
        mocks.remove.mockRejectedValue(new Error('Unmerged work retained'));
        const worker = start(); await settled(worker);
        expect(mocks.archive).toHaveBeenCalledWith('session1');
        expect(mocks.post.mock.calls.some(c => c[1].action?.type === 'complete-operation')).toBe(false);
        expect(mocks.post.mock.calls.some(c => c[1].action?.type === 'fail-operation')).toBe(true);
    });
    // B-691: retained cleanups were re-run every 5 s (≈2000 stop/archive/git passes each).
    it('re-checks a retained cleanup after 5 minutes, or at once on the owner retry', async () => {
        let now = 5_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const spawnOperation = { ...op(), status: 'completed' as const, sessionId: 'session1' };
            const cleanup = { ...op(), id: 'stop1', type: 'stop' as const, sessionId: 'session1' };
            const state = team([spawnOperation, cleanup]);
            const serve = (operation: TeamOperation) => { setup(operation); mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [operation], teams: [state] } : { team: state } })); };
            serve(cleanup);
            writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim0', phase: 'completed', directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
            mocks.remove.mockRejectedValueOnce(new Error('Unmerged work retained on team/B-1 at /isolated: 2 commits are not pushed or merged; push or merge, then retry cleanup'));
            const worker = start(); await settled(worker);
            expect(mocks.remove).toHaveBeenCalledTimes(1);
            expect(readReceipt(home, 'stop1')?.retryAt).toBe(now + 300_000);
            const failure = mocks.post.mock.calls.find(c => c[1].action?.type === 'fail-operation')!;
            expect(failure[1].action.error).toContain('push or merge, then retry cleanup');
            expect(failure[1].requestId).toMatch(/^failure-stop1-prepared-[0-9a-f]{12}$/);
            now += 60_000; await worker.tick();
            expect(mocks.remove).toHaveBeenCalledTimes(1);
            expect(mocks.archive).toHaveBeenCalledTimes(1); // no stop/archive churn while waiting
            serve({ ...cleanup, status: 'failed', claimId: 'claim1', retryRequestedAt: 9 });
            await worker.tick();
            expect(mocks.remove).toHaveBeenCalledTimes(2);
            expect(readReceipt(home, 'stop1')).toMatchObject({ phase: 'completed', retryConsumed: 9 });
        } finally { clock.mockRestore(); }
    });
    it('advances schedules in the existing poll and refuses a subsequently cancelled message', async () => {
        setup(op());
        const state = team([]);
        state.messages = [{ id: 'scheduled-1', taskId: null, scheduleId: 'scheduled', senderBotId: null, source: 'system', recipientBotId: 'bot1', body: 'Inspect', deliveredAt: null, createdAt: 1 }];
        const cancelled = structuredClone(state); cancelled.messages[0].cancelledAt = 2;
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [], teams: [state] } : { team: cancelled } }));
        const worker = start(() => true); await settled(worker);
        expect(mocks.post).toHaveBeenCalledWith('/v1/teams/schedules/tick', { machineId: 'machine1' });
        expect(mocks.send).not.toHaveBeenCalled();
    });
    it('retries a scheduled message across daemon restart using the same stable localId', async () => {
        setup(op());
        const state = team([]);
        state.messages = [{ id: 'scheduled-1', taskId: null, scheduleId: 'scheduled', senderBotId: null, source: 'system', recipientBotId: 'bot1', body: 'Inspect', deliveredAt: null, createdAt: 1 }];
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [], teams: [state] } : { team: state } }));
        const original = mocks.post.getMockImplementation()!;
        mocks.post.mockImplementation(async (...args) => { if (args[1].action?.type === 'message-delivered') throw new Error('ACK lost'); return original(...args); });
        const first = start(() => true); await settled(first); first.stop();
        const second = start(() => true); await settled(second);
        expect(mocks.send).toHaveBeenCalledTimes(2);
        expect(mocks.send.mock.calls.map(c => c[4].localId)).toEqual(['teams-message-scheduled-1-1', 'teams-message-scheduled-1-1']);
        expect(spawn).not.toHaveBeenCalled();
    });
    it('keeps ordinary Teams working when schedule advancement is unavailable on an old server', async () => {
        setup(op()); const original = mocks.post.getMockImplementation()!;
        mocks.post.mockImplementation(async (...args) => { if (args[0].endsWith('/schedules/tick')) throw new Error('404'); return original(...args); });
        const worker = start(); await settled(worker);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
    });

});

describe('frozen team execution policy', () => {
    it.each(['claude', 'codex', 'pi-acp'] as const)('passes owner-approved bypass to %s', async assistant => {
        setup({ ...op(), assistant, permissionMode: 'bypassPermissions' });
        const worker = start(); await settled(worker);
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: assistant === 'pi-acp' ? 'pi' : assistant, permissionMode: 'bypassPermissions' }));
    });
    it('old operations remain default even when the team policy changes', async () => {
        const operation = op(); setup(operation);
        const state = { ...team([operation]), permissionMode: 'bypassPermissions' };
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [operation], teams: [state] } : { team: state } }));
        const worker = start(); await settled(worker);
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'default' }));
    });
});

describe('B-730: rebuilding a relaunched member scope', () => {
    const claimed = () => ({ ...op(), status: 'completed' as const, claimId: 'claim1', sessionId: 'session1', teamLaunchVersion: 1 as const });
    const setupListed = (operation: TeamOperation) => {
        setup(operation);
        const original = mocks.get.getMockImplementation()!;
        mocks.get.mockImplementation(async (path: string) => path === '/v1/teams' ? { data: { teams: [team([operation])] } } : original(path));
    };
    it('replays this daemon\'s claim for an unchanged binding and writes the private scope file', async () => {
        setupListed(claimed());
        const file = join(home, 'teams', 'scopes', 'op1.json');
        await start().recoverScope('op1', 'session1', file);
        const claim = mocks.post.mock.calls.find(([, request]) => request.action?.type === 'claim-operation')!;
        expect(claim[1]).toEqual({ requestId: 'claim-op1', action: { type: 'claim-operation', operationId: 'op1', machineId: 'machine1', teamLaunchVersion: 1 } });
        const { readFileSync, statSync } = await import('node:fs');
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ serverUrl: 'http://127.0.0.1:1', scopeToken: 'scoped-test', teamId: 'team1', botId: 'bot1', taskId: 'task1', attemptId: 'attempt1' });
        if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
    });
    it.each([
        ['another session now holds the bot', (t: TeamState) => { t.bots[0].sessionId = 'session2'; }],
        ['the bot moved to a new generation', (t: TeamState) => { t.bots[0].generation = 2; }],
        ['the team is archived', (t: TeamState) => { t.archivedAt = 5; }],
    ])('refuses when %s', async (_label, mutate) => {
        setupListed(claimed());
        const original = mocks.get.getMockImplementation()!;
        mocks.get.mockImplementation(async (...args) => { const result = await original(...args); for (const t of result.data.teams ?? []) mutate(t); return result; });
        await expect(start().recoverScope('op1', 'session1', join(home, 'teams', 'scopes', 'op1.json'))).rejects.toThrow();
        expect(mocks.post.mock.calls.some(([, request]) => request.action?.type === 'claim-operation')).toBe(false);
    });
});

