import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IssueDispatchView } from '@slopus/happy-wire';
const mocks = vi.hoisted(() => ({ persisted: vi.fn(() => ({})) }));
vi.mock('@/configuration', () => ({ configuration: { happyHomeDir: '', serverUrl: '' } }));
vi.mock('@/persistence', () => ({ readPersistedSessions: mocks.persisted }));
vi.mock('@/commands/sessionMessage', () => ({ sendUserMessage: vi.fn(), waitForSessionKey: vi.fn() }));
import { IssueRequestError, IssuesUnsupportedError } from '@/issues/client';
import { createIssueWorker, ISSUE_SPAWN_UNKNOWN_GRACE_MS, issueAccountRefusal, issueExitEvent, issueKeyFromPrompt, issueSpawnAccount } from './worker';
import { readIssueReceipt, writeIssueReceipt } from './journal';

let home: string;
const PREVIEW = 'You are assigned issue VH-3: preview (stale)';
const FROZEN = 'You are assigned issue VH-3: Fix login\nstatus: todo\n\nIssue status rules (Very Happy):';
const spawnDispatch = (over: Partial<IssueDispatchView> = {}): IssueDispatchView => ({
    id: 'd1', kind: 'spawn', issueId: 'i1', runId: 'r1', machineId: 'm1', claimId: null, createdAt: 1,
    spawn: { agent: 'codex', directory: '/repo', projectId: 'p1', prompt: PREVIEW, model: null, permissionMode: 'yolo' }, ...over,
});
const messageDispatch = (id = 'd2'): IssueDispatchView => ({ id, kind: 'message', issueId: 'i1', runId: 'r1', machineId: 'm1', claimId: null, createdAt: 2, message: { sessionId: 's1', text: 'New comment on VH-3', commentId: 'c1' } });

function fakeClient(dispatches: IssueDispatchView[]) {
    return {
        poll: vi.fn(async () => ({ dispatches })),
        claim: vi.fn(async (id: string) => {
            const d = dispatches.find(x => x.id === id)!;
            return { dispatch: { ...d, claimId: `claim-${id}`, ...(d.spawn ? { spawn: { ...d.spawn, prompt: FROZEN } } : {}) } };
        }),
        complete: vi.fn(async () => ({ ok: true as const })),
        fail: vi.fn(async () => ({ ok: true as const })),
        sessionEvent: vi.fn(async () => ({ ok: true as const })),
    };
}

function start(client: ReturnType<typeof fakeClient>, extra: Partial<Parameters<typeof createIssueWorker>[0]> = {}) {
    const order: string[] = [];
    const spawn = vi.fn(async (opts: any) => { order.push('spawn'); void opts; return { type: 'success' as const, sessionId: 's1' }; });
    const send = vi.fn(async (sid: string, _text: string, opts: any) => { order.push(`send:${sid}:${opts?.localId}`); });
    const joinProject = vi.fn(async () => { order.push('join'); });
    client.complete.mockImplementation(async () => { order.push('complete'); return { ok: true as const }; });
    const worker = createIssueWorker({ machineId: 'm1', client: client as any, spawn, send, joinProject, live: () => true, log: () => {}, home, capabilities: () => [], autoStart: false, ...extra });
    return { worker, spawn, send, joinProject, order };
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'b874-issue-worker-')); mocks.persisted.mockReturnValue({}); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('daemon issue worker (spec §3.2 / §11)', () => {
    it('spawn: claim → spawn(via issue env) → joinProject → first message with the CLAIMED prompt → complete', async () => {
        const client = fakeClient([spawnDispatch()]);
        const { worker, spawn, send, order } = start(client);
        await worker.tick();
        expect(client.claim).toHaveBeenCalledWith('d1', 'm1');
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo', agent: 'codex', permissionMode: 'yolo', spawnedBy: 'issue',
            environmentVariables: { VH_ISSUE_ID: 'i1', VH_ISSUE_RUN_ID: 'r1', VH_ISSUE_KEY: 'VH-3' },
        }));
        expect(send).toHaveBeenCalledWith('s1', FROZEN, expect.objectContaining({ localId: 'issue-d1', sentFrom: 'issue' }));
        expect(send.mock.calls[0][1]).not.toBe(PREVIEW);
        expect(order).toEqual(['spawn', 'join', 'send:s1:issue-d1', 'complete']);
        expect(client.complete).toHaveBeenCalledWith('d1', { machineId: 'm1', claimId: 'claim-d1', sessionId: 's1' });
        expect(readIssueReceipt(home, 'd1')).toMatchObject({ phase: 'completed', sessionId: 's1' });
        expect(worker.hasSession('s1')).toBe(true);
    });
    it('a lost claim race spawns nothing', async () => {
        const client = fakeClient([spawnDispatch()]);
        client.claim.mockRejectedValue(new IssueRequestError(409, 'issue_dispatch_claim_mismatch', {}));
        const { worker, spawn } = start(client);
        await worker.tick();
        expect(spawn).not.toHaveBeenCalled();
        expect(client.fail).not.toHaveBeenCalled();
    });
    it('an unusable account is refused before spawning (never the machine login) and fails the dispatch', async () => {
        const client = fakeClient([spawnDispatch({ spawn: { ...spawnDispatch().spawn!, agentProfile: { id: 'acct-1' } as any } })]);
        const resolveAccount = vi.fn(() => { throw new Error('agent-profile-unavailable:expired: token expired'); });
        const { worker, spawn } = start(client, { resolveAccount });
        await worker.tick();
        expect(resolveAccount).toHaveBeenCalledWith('codex', 'acct-1');
        expect(spawn).not.toHaveBeenCalled();
        expect(client.fail).toHaveBeenCalledWith('d1', expect.objectContaining({ claimId: 'claim-d1', error: expect.stringMatching(/^Account unavailable \(expired\)/) }));
        expect((client.fail.mock.calls[0] as any[])[1].unknown).toBeUndefined();
    });
    it('a re-claimed dispatch whose spawn had begun never spawns again: recovered by run id, else held then failed (never unknown)', async () => {
        writeIssueReceipt(home, { dispatchId: 'd1', kind: 'spawn', runId: 'r1', issueId: 'i1', claimId: 'old', phase: 'spawning', updatedAt: Date.now() });
        let t = 1_000;
        const client = fakeClient([spawnDispatch()]);
        const { worker, spawn } = start(client, { now: () => t });
        await worker.tick();
        expect(spawn).not.toHaveBeenCalled();
        expect(client.fail).not.toHaveBeenCalled();
        client.poll.mockResolvedValue({ dispatches: [] }); // claimed now: no longer polled
        t += ISSUE_SPAWN_UNKNOWN_GRACE_MS;
        await worker.tick();
        expect(spawn).not.toHaveBeenCalled();
        expect(client.fail).toHaveBeenCalledTimes(1);
        expect((client.fail.mock.calls[0] as any[])[1]).toEqual({ machineId: 'm1', claimId: 'claim-d1', error: expect.stringMatching(/^Session did not start within 60 s \(the spawn was interrupted by a daemon restart\)/) });
        expect(readIssueReceipt(home, 'd1')).toMatchObject({ phase: 'failed' });

        writeIssueReceipt(home, { dispatchId: 'd1', kind: 'spawn', runId: 'r1', issueId: 'i1', claimId: 'old', phase: 'spawning', updatedAt: Date.now() });
        mocks.persisted.mockReturnValue({ s9: { metadata: { issue: { id: 'i1', runId: 'r1' } } } } as any);
        const again = fakeClient([spawnDispatch()]);
        const second = start(again);
        await second.worker.tick();
        expect(second.spawn).not.toHaveBeenCalled();
        expect(again.complete).toHaveBeenCalledWith('d1', { machineId: 'm1', claimId: 'claim-d1', sessionId: 's9' });
    });
    it('B-874c: a spawn refused before any process existed (directory not creatable) or whose wrapper exited fails the run with the reason', async () => {
        const mkdirError = "Unable to create directory at '/nonexistent/x'. Permission denied. You don't have write access to create a folder at this location.";
        const client = fakeClient([spawnDispatch()]);
        const { worker } = start(client, { spawn: vi.fn(async () => ({ type: 'error' as const, errorMessage: mkdirError, notStarted: true as const })) });
        await worker.tick();
        expect(client.fail).toHaveBeenCalledTimes(1);
        expect((client.fail.mock.calls[0] as any[])[1]).toEqual({ machineId: 'm1', claimId: 'claim-d1', error: `Session failed to start: ${mkdirError}` });
        expect(readIssueReceipt(home, 'd1')).toMatchObject({ phase: 'failed' });

        const c2 = fakeClient([spawnDispatch({ id: 'd3' })]);
        const w2 = start(c2, { spawn: vi.fn(async () => ({ type: 'error' as const, errorMessage: 'boom', startupExit: { exited: true } as any })) });
        await w2.worker.tick();
        expect((c2.fail.mock.calls[0] as any[])[1]).toEqual({ machineId: 'm1', claimId: 'claim-d3', error: 'Session failed to start: boom' });
    });
    it('B-874c: an unconfirmed spawn holds its claim, recovers a late session, else fails after the grace (never stuck claimed)', async () => {
        let t = 0;
        const timeout = vi.fn(async () => ({ type: 'error' as const, errorMessage: 'Session webhook timeout for PID 42' }));
        const late = fakeClient([spawnDispatch()]);
        const w1 = start(late, { spawn: timeout, now: () => t });
        await w1.worker.tick();
        expect(late.fail).not.toHaveBeenCalled();
        late.poll.mockResolvedValue({ dispatches: [] });
        // The wrapper comes up late: its persisted metadata names the run.
        mocks.persisted.mockReturnValue({ s5: { metadata: { issue: { id: 'i1', runId: 'r1' } } } } as any);
        t += 5_000;
        await w1.worker.tick();
        expect(late.fail).not.toHaveBeenCalled();
        expect(w1.order).toEqual(['join', 'send:s5:issue-d1', 'complete']);
        expect(w1.worker.hasSession('s5')).toBe(true);
        expect(timeout).toHaveBeenCalledTimes(1);

        mocks.persisted.mockReturnValue({});
        const never = fakeClient([spawnDispatch({ id: 'd7', runId: 'r7' })]);
        const timeout2 = vi.fn(async () => ({ type: 'error' as const, errorMessage: 'Session webhook timeout for PID 43' }));
        const w2 = start(never, { spawn: timeout2, now: () => t });
        await w2.worker.tick();
        never.poll.mockResolvedValue({ dispatches: [] });
        t += ISSUE_SPAWN_UNKNOWN_GRACE_MS - 1;
        await w2.worker.tick();
        expect(never.fail).not.toHaveBeenCalled();
        t += 1;
        await w2.worker.tick();
        expect(never.fail).toHaveBeenCalledTimes(1);
        expect((never.fail.mock.calls[0] as any[])[1]).toEqual({ machineId: 'm1', claimId: 'claim-d7', error: expect.stringContaining('Session did not start within 60 s (Session webhook timeout for PID 43)') });
        await w2.worker.tick();
        expect(never.fail).toHaveBeenCalledTimes(1);
        expect(timeout2).toHaveBeenCalledTimes(1);
    });
    it('B-874c: a held spawn whose claim is gone is dropped (the next claim decides)', async () => {
        let t = 0;
        const client = fakeClient([spawnDispatch()]);
        const { worker } = start(client, { spawn: vi.fn(async () => ({ type: 'error' as const, errorMessage: 'webhook timeout' })), now: () => t });
        await worker.tick();
        client.poll.mockResolvedValue({ dispatches: [] });
        client.fail.mockRejectedValue(new IssueRequestError(409, 'issue_dispatch_claim_mismatch', {}));
        t += ISSUE_SPAWN_UNKNOWN_GRACE_MS;
        await worker.tick();
        await worker.tick();
        expect(client.fail).toHaveBeenCalledTimes(1);
    });
    it('message: queued into a live session (no steer, no model meta), else failed so the server starts a new run', async () => {
        const client = fakeClient([messageDispatch()]);
        const { worker, send } = start(client);
        await worker.tick();
        expect(send).toHaveBeenCalledWith('s1', 'New comment on VH-3', { localId: 'issue-d2', sentFrom: 'issue' });
        expect(client.complete).toHaveBeenCalledWith('d2', { machineId: 'm1', claimId: 'claim-d2', sessionId: 's1' });
        const dead = fakeClient([messageDispatch('d4')]);
        const w2 = start(dead, { live: () => false });
        await w2.worker.tick();
        expect(w2.send).not.toHaveBeenCalled();
        expect(dead.fail).toHaveBeenCalledWith('d4', expect.objectContaining({ error: 'Session is not running on this machine' }));
    });
    it('an old server / switch off claims nothing (the client backs off)', async () => {
        const client = fakeClient([]);
        client.poll.mockRejectedValue(new IssuesUnsupportedError());
        const { worker } = start(client);
        await worker.tick();
        expect(client.claim).not.toHaveBeenCalled();
    });
    it('session events: only for run sessions, deduplicated, exit retires the session', async () => {
        const client = fakeClient([spawnDispatch()]);
        const { worker } = start(client);
        await worker.tick();
        worker.report('other', 'idle');
        worker.report('s1', 'running'); // already running after complete
        worker.report('s1', 'idle');
        worker.report('s1', 'idle');
        worker.report('s1', 'exited');
        await new Promise(resolve => setImmediate(resolve));
        await worker.tick();
        expect(client.sessionEvent.mock.calls.map(c => (c as any[])[1].event)).toEqual(['idle', 'exited']);
        expect(worker.hasSession('s1')).toBe(false);
        expect(readIssueReceipt(home, 'd1')).toMatchObject({ ended: true });
    });
    it('a restarted daemon keeps reporting for its live run sessions (rebuilt from receipts)', async () => {
        writeIssueReceipt(home, { dispatchId: 'd1', kind: 'spawn', runId: 'r1', issueId: 'i1', claimId: 'k', phase: 'completed', sessionId: 's7', updatedAt: Date.now() });
        const { worker } = start(fakeClient([]));
        expect(worker.hasSession('s7')).toBe(true);
    });
});

describe('issue worker helpers', () => {
    it('reads the key from the frozen prompt, maps accounts, classifies exits like B-505', () => {
        expect(issueKeyFromPrompt(FROZEN)).toBe('VH-3');
        expect(issueKeyFromPrompt('hello')).toBeNull();
        expect(issueSpawnAccount({})).toBeUndefined();
        expect(issueSpawnAccount({ agentProfile: null })).toBeNull();
        expect(issueSpawnAccount({ agentProfile: { id: 'a' } as any })).toBe('a');
        expect(issueAccountRefusal(() => 'x', 'pi', 'a')).toMatch(/agent-mismatch/);
        expect(issueAccountRefusal(() => 'x', 'pi', undefined)).toBeNull();
        expect(issueAccountRefusal(undefined, 'codex', 'a')).toBeNull();
        expect(issueExitEvent({ code: 0, signal: null })).toBe('exited');
        expect(issueExitEvent({ code: null, signal: 'SIGTERM' })).toBe('exited');
        expect(issueExitEvent({ code: 143, signal: null })).toBe('exited');
        expect(issueExitEvent({ code: 1, signal: null })).toBe('crashed');
        expect(issueExitEvent({ code: null, signal: 'SIGKILL' })).toBe('crashed');
        expect(issueExitEvent(undefined)).toBe('exited');
    });
});
