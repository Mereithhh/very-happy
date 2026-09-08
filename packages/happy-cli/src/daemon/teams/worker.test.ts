import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TeamOperation, TeamState } from '@slopus/happy-wire';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), send: vi.fn(), key: vi.fn(), persisted: vi.fn(), prepare: vi.fn(), remove: vi.fn(), archive: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({ get: mocks.get, post: mocks.post }), isAxiosError: () => false } }));
vi.mock('@/configuration', () => ({ configuration: { happyHomeDir: '', serverUrl: '' } }));
vi.mock('@/persistence', () => ({ readPersistedSessions: mocks.persisted }));
vi.mock('@/commands/sessionMessage', () => ({ sendUserMessage: mocks.send, waitForSessionKey: mocks.key }));
vi.mock('@/sessions/sessionOps', () => ({ archiveSession: mocks.archive }));
vi.mock('./worktree', () => ({ prepareTeamWorktree: mocks.prepare, removeTeamWorktree: mocks.remove }));
import { createTeamWorker } from './worker';
import { readReceipt, writeReceipt } from './journal';

let home: string;
let workers: ReturnType<typeof createTeamWorker>[] = [];
const op = (): TeamOperation => ({ id: 'op1', teamId: 'team1', machineId: 'machine1', taskId: 'task1', botId: 'bot1', attemptId: 'attempt1', generation: 1, type: 'spawn', status: 'pending', claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/repo', assistant: 'codex', prompt: 'A bounded task', createdAt: 1 });
const team = (operations: TeamOperation[]): TeamState => ({ id: 'team1', name: 'Team', machineId: 'machine1', version: 1, bots: [], tasks: [], messages: [], operations, createdAt: 1 });
const spawn = vi.fn();
const stop = vi.fn();
function start() {
    const worker = createTeamWorker({ home, serverUrl: 'http://127.0.0.1:1', machineId: 'machine1', token: 'test', spawn, stop, live: () => false, log: () => {} });
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
    mocks.post.mockImplementation(async (_: string, request: { action: { type: string } }) => ({ data: { team: state, operation: { ...operation, status: 'claimed', claimId: 'claim1' }, ...(request.action.type === 'claim-operation' ? { credential: { botId: 'bot1', token: 'scoped-test' } } : {}) } }));
}
beforeEach(() => {
    vi.clearAllMocks();
    const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'worker-'));
    mocks.persisted.mockReturnValue({});
    mocks.prepare.mockResolvedValue({ directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
    mocks.key.mockResolvedValue(new Uint8Array(32));
    mocks.send.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    spawn.mockReset().mockResolvedValue({ type: 'success', sessionId: 'session1' });
});
afterEach(() => { workers.forEach(w => w.stop()); workers = []; rmSync(home, { recursive: true, force: true }); });

describe('daemon team effect recovery', () => {
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
            if (args[1].action.type === 'complete-operation' && !failed) { failed = true; throw new Error('lost ACK'); }
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
        expect(mocks.post.mock.calls.some(c => c[1].action.unknown === true)).toBe(true);
        mocks.persisted.mockReturnValue({ session1: { metadata: { teamOperationId: 'op1' } } });
        await worker.tick();
        expect(spawn).not.toHaveBeenCalled();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(readReceipt(home, 'op1')?.phase).toBe('completed');
    });
    it('never claims a previously claimed operation when its local effect receipt is absent', async () => {
        setup({ ...op(), status: 'claimed', claimId: 'claim1' });
        const worker = start(); await settled(worker);
        expect(mocks.post).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
    });
    it('preserves failed cleanup for another pass and never marks it completed', async () => {
        const spawnOperation = { ...op(), status: 'completed' as const };
        const cleanup = { ...op(), id: 'stop1', type: 'stop' as const, sessionId: 'session1' };
        setup(cleanup);
        const state = team([spawnOperation, cleanup]);
        mocks.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/operations') ? { operations: [cleanup], teams: [state] } : { team: state } }));
        writeReceipt(home, { operationId: 'op1', teamId: 'team1', claimId: 'claim0', phase: 'completed', directory: '/isolated', repository: '/repo', branch: 'codex/team-op1' });
        mocks.remove.mockRejectedValue(new Error('Unmerged work retained'));
        const worker = start(); await settled(worker);
        expect(mocks.archive).toHaveBeenCalledWith('session1');
        expect(mocks.post.mock.calls.some(c => c[1].action.type === 'complete-operation')).toBe(false);
        expect(mocks.post.mock.calls.some(c => c[1].action.type === 'fail-operation')).toBe(true);
    });
});
