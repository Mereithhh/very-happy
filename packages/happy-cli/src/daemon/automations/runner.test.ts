import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Automation, AutomationClaimedRun, AutomationRun } from '@slopus/happy-wire';
const mocks = vi.hoisted(() => ({ persisted: vi.fn() }));
vi.mock('@/configuration', () => ({ configuration: { happyHomeDir: '', serverUrl: '', currentCliVersion: '0' } }));
vi.mock('@/persistence', () => ({ readPersistedSessions: mocks.persisted, readCredentialsForConfiguredRelay: vi.fn(), readSettings: vi.fn() }));
vi.mock('@/commands/sessionMessage', () => ({ sendUserMessage: vi.fn(), waitForSessionKey: vi.fn() }));
vi.mock('@/sessions/sessionOps', () => ({ readSessionLog: vi.fn(), TURN_WINDOW: 500 }));
import { AutomationsRequestError } from '@/automations/client';
import { AUTOMATION_LEASE_RENEW_MS, AUTOMATION_UNAVAILABLE_LOG_MS, automationPromptHeader, createAutomationRunner } from './runner';
import { readReceipt, writeReceipt } from './receipts';

let home: string;
let runners: ReturnType<typeof createAutomationRunner>[] = [];
let clock = 1_000_000;
const now = () => clock;

const automation = (overrides: Partial<Automation> = {}): Automation => ({
    id: 'a1', name: 'nightly', description: null, machineId: 'm1', status: 'active', trigger: { kind: 'manual' },
    action: { kind: 'spawn', agent: 'claude', directory: '/repo', prompt: 'Summarize {{payload.topic}} for {{automation.name}}' },
    concurrency: 'skip', maxRuntimeMs: 3_600_000, nextRunAt: null, version: 1, lastRunAt: null, lastRunStatus: null, createdAt: 1, updatedAt: 1, ...overrides,
});
const run = (overrides: Partial<AutomationRun & { claimId: string }> = {}): AutomationRun & { claimId: string } => ({
    id: 'r1', automationId: 'a1', automationName: 'nightly', machineId: 'm1', source: 'manual', dedupeKey: null, payload: '{"topic":"tanka"}', status: 'claimed',
    needsAttention: false, attentionReason: null, sessionId: null, stickyKey: null, scheduledFor: null, claimedAt: 1, leaseUntil: 2, startedAt: null, finishedAt: null,
    summary: null, error: null, exitCode: null, createdAt: 1, updatedAt: 1, claimId: 'claim-1', ...overrides,
});
const claimed = (r = run(), a = automation(), stickies: AutomationClaimedRun['stickies'] = []): AutomationClaimedRun => ({ run: r, automation: a, stickies });

function fakeClient(runsToClaim: AutomationClaimedRun[] = []) {
    const client = {
        claim: vi.fn().mockImplementation(async () => { const runs = runsToClaim.splice(0); return { runs, leaseMs: 60_000 }; }),
        report: vi.fn().mockImplementation(async (id: string, body: any) => ({ ...run({ id }), status: body.status ?? 'running' })),
        deleteSticky: vi.fn().mockResolvedValue(true),
    };
    return client;
}
const spawn = vi.fn();
const send = vi.fn();
const readTurn = vi.fn();
const runScript = vi.fn();
const live = new Set<string>();
const turning = new Set<string>();
const log = vi.fn();

function start(client: any, extra: Partial<Parameters<typeof createAutomationRunner>[0]> = {}) {
    const runner = createAutomationRunner({ home, machineId: 'm1', token: 't', client, spawn, send, readTurn, runScript, live: (id) => live.has(id), turnActive: (id) => turning.has(id), log, now, tickMs: 1e9, ...extra });
    runners.push(runner);
    return runner;
}
async function settled(runner: ReturnType<typeof createAutomationRunner>) {
    for (let i = 0; i < 200 && runner.busy; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(runner.busy).toBe(false);
}
async function flush() { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); }

beforeEach(() => {
    vi.clearAllMocks();
    clock = 1_000_000;
    live.clear(); turning.clear();
    const root = join(homedir(), 'code/github/skills/tmp/vh-automation/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'runner-'));
    mocks.persisted.mockReturnValue({ s1: { metadata: { capabilities: ['claude-opus-5-5-v1'] } } });
    spawn.mockReset().mockImplementation(async () => { live.add('s1'); return { type: 'success', sessionId: 's1' }; });
    send.mockReset().mockResolvedValue(undefined);
    readTurn.mockReset().mockResolvedValue({ ended: false, status: null, error: null, answer: '', userSeq: 1, lastSeq: 1 });
    runScript.mockReset();
});
afterEach(() => { runners.forEach((r) => r.stop()); runners = []; rmSync(home, { recursive: true, force: true }); });

describe('automation runner: spawn runs', () => {
    it('spawns with run env, sends the rendered prompt, reports running, then done after the turn ends', async () => {
        const client = fakeClient([claimed()]);
        const runner = start(client); await settled(runner);
        expect(client.claim).toHaveBeenCalledWith({ machineId: 'm1', leaseMs: 60_000 });
        expect(spawn).toHaveBeenCalledWith({ directory: '/repo', agent: 'claude', permissionMode: 'bypassPermissions', spawnedBy: 'automation', environmentVariables: { VH_AUTOMATION_RUN_ID: 'r1', VH_AUTOMATION_NAME: 'nightly' } });
        expect(send).toHaveBeenCalledWith('s1', `${automationPromptHeader('nightly', 'r1')}\nSummarize tanka for nightly`, expect.objectContaining({ localId: 'automation-r1', permissionMode: 'bypassPermissions', model: 'claude-opus-5-5', effort: null }));
        expect(client.report).toHaveBeenCalledWith('r1', { claimId: 'claim-1', status: 'running', sessionId: 's1' });
        expect(readReceipt(home, 'r1')?.phase).toBe('running');
        expect(runner.hasSession('s1')).toBe(true);
        // Idle before any turn started is not completion (the wrapper may still be booting).
        await runner.tick();
        expect(client.report).toHaveBeenCalledTimes(1);
        turning.add('s1'); await runner.tick();
        turning.delete('s1');
        readTurn.mockResolvedValue({ ended: true, status: 'completed', error: null, answer: 'All good.', userSeq: 1, lastSeq: 9 });
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', status: 'done', sessionId: 's1', summary: 'All good.' });
        expect(readReceipt(home, 'r1')?.phase).toBe('finished');
        expect(runner.hasSession('s1')).toBe(false);
        // The same run claimed again is never spawned twice.
        client.claim.mockResolvedValueOnce({ runs: [claimed()], leaseMs: 60_000 });
        await runner.tick();
        expect(spawn).toHaveBeenCalledTimes(1);
    });
    it('marks a failed turn or a dead session as failed with attention', async () => {
        const client = fakeClient([claimed()]);
        const runner = start(client); await settled(runner);
        turning.add('s1'); await runner.tick(); turning.delete('s1');
        readTurn.mockResolvedValue({ ended: true, status: 'failed', error: 'model error', answer: '', userSeq: 1, lastSeq: 2 });
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', status: 'failed', sessionId: 's1', error: 'model error', needsAttention: true, attentionReason: 'turn_failed' });

        client.claim.mockResolvedValueOnce({ runs: [claimed(run({ id: 'r2', claimId: 'claim-2' }))], leaseMs: 60_000 });
        await runner.tick();
        live.delete('s1'); runner.report('s1', 'exited');
        readTurn.mockResolvedValue({ ended: false, status: null, error: null, answer: '', userSeq: 1, lastSeq: 2 });
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('r2', { claimId: 'claim-2', status: 'failed', sessionId: 's1', error: 'Session exited before the turn ended', needsAttention: true, attentionReason: 'session_exited' });
    });
    it('stops tracking when the agent reported explicitly (learned from lease renewal) and flags needs_input', async () => {
        const client = fakeClient([claimed()]);
        const runner = start(client); await settled(runner);
        runner.report('s1', 'blocked'); await flush();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', needsAttention: true, attentionReason: 'needs_input' });
        client.report.mockResolvedValueOnce(run({ status: 'done' }));
        clock += AUTOMATION_LEASE_RENEW_MS;
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', leaseMs: 60_000 });
        expect(runner.trackedRunIds()).toEqual([]);
        expect(readReceipt(home, 'r1')?.phase).toBe('finished');
    });
    it('fails fast on an unknown agent or a spawn error, without a receipt that blocks retries', async () => {
        const client = fakeClient([claimed(run(), automation({ action: { kind: 'spawn', agent: 'mystery', directory: '/repo', prompt: 'x' } }))]);
        const runner = start(client); await settled(runner);
        expect(spawn).not.toHaveBeenCalled();
        expect(client.report).toHaveBeenCalledWith('r1', { claimId: 'claim-1', status: 'failed', error: 'Unknown agent "mystery"', needsAttention: true, attentionReason: 'invalid_action' });
        spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'no claude' });
        client.claim.mockResolvedValueOnce({ runs: [claimed(run({ id: 'r2', claimId: 'c2' }))], leaseMs: 60_000 });
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('r2', { claimId: 'c2', status: 'failed', error: 'no claude', needsAttention: true, attentionReason: 'spawn_failed' });
        expect(readReceipt(home, 'r2')?.phase).toBe('finished');
    });
});

describe('automation runner: sticky and send', () => {
    const sticky = automation({ action: { kind: 'spawn', agent: 'codex', directory: '/repo', prompt: 'Reply to {{payload.text}}', sticky: { key: 'conv-{{payload.conversationId}}' } } });
    const payload = JSON.stringify({ conversationId: 'c9', text: 'hi' });
    it('continues a live sticky session and registers the key on the run', async () => {
        live.add('old');
        const client = fakeClient([claimed(run({ payload }), sticky, [{ key: 'conv-c9', sessionId: 'old', updatedAt: 1 }])]);
        const runner = start(client); await settled(runner);
        expect(spawn).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith('old', `${automationPromptHeader('nightly', 'r1')}\nReply to hi`, { localId: 'automation-r1' });
        expect(client.report).toHaveBeenCalledWith('r1', { claimId: 'claim-1', status: 'running', sessionId: 'old', stickyKey: 'conv-c9' });
        expect(readReceipt(home, 'r1')).toMatchObject({ kind: 'send', sessionId: 'old', stickyKey: 'conv-c9' });
    });
    it('replaces a dead sticky binding: clears it, spawns, and reports the new binding', async () => {
        const client = fakeClient([claimed(run({ payload }), sticky, [{ key: 'conv-c9', sessionId: 'dead', updatedAt: 1 }])]);
        const runner = start(client); await settled(runner);
        expect(client.deleteSticky).toHaveBeenCalledWith('a1', 'conv-c9');
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', permissionMode: 'yolo' }));
        expect(client.report).toHaveBeenCalledWith('r1', { claimId: 'claim-1', status: 'running', sessionId: 's1', stickyKey: 'conv-c9' });
    });
    it('sends into a fixed session only when it is live here', async () => {
        const target = automation({ action: { kind: 'send', sessionId: 'fixed', prompt: 'ping {{run.id}}' } });
        const client = fakeClient([claimed(run(), target)]);
        const runner = start(client); await settled(runner);
        expect(send).not.toHaveBeenCalled();
        expect(client.report).toHaveBeenCalledWith('r1', { claimId: 'claim-1', status: 'failed', error: 'Session fixed is not running on this machine', sessionId: 'fixed', needsAttention: true, attentionReason: 'session_not_live' });
        live.add('fixed');
        client.claim.mockResolvedValueOnce({ runs: [claimed(run({ id: 'r2', claimId: 'c2' }), target)], leaseMs: 60_000 });
        await runner.tick();
        expect(send).toHaveBeenCalledWith('fixed', `${automationPromptHeader('nightly', 'r2')}\nping r2`, { localId: 'automation-r2' });
        expect(client.report).toHaveBeenLastCalledWith('r2', { claimId: 'c2', status: 'running', sessionId: 'fixed' });
    });
});

describe('automation runner: scripts', () => {
    const script = automation({ maxRuntimeMs: 1_800_000, action: { kind: 'script', command: ['/bin/echo', '{{payload.topic}}'], cwd: '~/work', env: { TOPIC: '{{payload.topic}}' } } });
    it('runs argv with run env, reports running then done with the output tail and exit code', async () => {
        let resolveScript!: (value: any) => void;
        runScript.mockImplementation((options) => { options.onStart?.({ exitCode: null, kill: vi.fn() }); return new Promise((resolve) => { resolveScript = resolve; }); });
        const client = fakeClient([claimed(run(), script)]);
        const runner = start(client); await settled(runner);
        expect(runScript).toHaveBeenCalledWith(expect.objectContaining({ command: ['/bin/echo', 'tanka'], cwd: join(homedir(), 'work'), timeoutMs: 1_800_000, env: { TOPIC: 'tanka', VH_AUTOMATION_RUN_ID: 'r1', VH_AUTOMATION_NAME: 'nightly', VH_AUTOMATION_PAYLOAD: '{"topic":"tanka"}' } }));
        expect(client.report).toHaveBeenCalledWith('r1', { claimId: 'claim-1', status: 'running' });
        resolveScript({ exitCode: 0, signal: null, timedOut: false, output: 'tanka\n' }); await flush();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', status: 'done', summary: 'tanka\n', exitCode: 0 });
        expect(readReceipt(home, 'r1')?.phase).toBe('finished');
    });
    it('reports non-zero exits, timeouts and launch failures as failed', async () => {
        runScript.mockResolvedValueOnce({ exitCode: 2, signal: null, timedOut: false, output: 'boom' });
        const client = fakeClient([claimed(run(), script)]);
        const runner = start(client); await settled(runner); await flush();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', status: 'failed', summary: 'boom', exitCode: 2, error: 'Exit 2' });
        runScript.mockResolvedValueOnce({ exitCode: null, signal: 'SIGKILL', timedOut: true, output: '' });
        client.claim.mockResolvedValueOnce({ runs: [claimed(run({ id: 'r2', claimId: 'c2' }), script)], leaseMs: 60_000 });
        await runner.tick(); await flush();
        expect(client.report).toHaveBeenLastCalledWith('r2', { claimId: 'c2', status: 'failed', summary: '', exitCode: null, error: 'Timed out after 1800000ms' });
        runScript.mockResolvedValueOnce({ exitCode: null, signal: null, timedOut: false, output: '', error: 'ENOENT' });
        client.claim.mockResolvedValueOnce({ runs: [claimed(run({ id: 'r3', claimId: 'c3' }), script)], leaseMs: 60_000 });
        await runner.tick(); await flush();
        expect(client.report).toHaveBeenLastCalledWith('r3', { claimId: 'c3', status: 'failed', summary: '', exitCode: null, error: 'Launch failed: ENOENT' });
    });
    it('kills the child when the server cancels the run', async () => {
        const kill = vi.fn();
        runScript.mockImplementation((options) => { options.onStart?.({ exitCode: null, kill }); return new Promise(() => {}); });
        const client = fakeClient([claimed(run(), script)]);
        const runner = start(client); await settled(runner);
        client.report.mockRejectedValueOnce(new AutomationsRequestError(409, 'run_finished', 'cancelled'));
        clock += AUTOMATION_LEASE_RENEW_MS;
        await runner.tick();
        expect(kill).toHaveBeenCalledWith('SIGTERM');
        expect(runner.trackedRunIds()).toEqual([]);
    });
});

describe('automation runner: restarts and degraded servers', () => {
    it('never re-spawns after a restart: unknown launches fail with attention, running sessions are re-tracked, scripts fail', async () => {
        writeReceipt(home, { runId: 'unknown', automationId: 'a1', kind: 'spawn', phase: 'starting', claimId: 'cu' });
        writeReceipt(home, { runId: 'session', automationId: 'a1', kind: 'spawn', phase: 'running', claimId: 'cs', sessionId: 's1' });
        writeReceipt(home, { runId: 'script', automationId: 'a1', kind: 'script', phase: 'running', claimId: 'cx' });
        writeReceipt(home, { runId: 'old', automationId: 'a1', kind: 'script', phase: 'finished', claimId: 'co' });
        live.add('s1');
        const client = fakeClient([claimed(run({ id: 'unknown', claimId: 'cu' })), claimed(run({ id: 'session', claimId: 'cs' }))]);
        const runner = start(client); await settled(runner);
        expect(spawn).not.toHaveBeenCalled();
        expect(client.report).toHaveBeenCalledWith('unknown', { claimId: 'cu', status: 'failed', error: 'Daemon restarted before the launch outcome was known', needsAttention: true, attentionReason: 'unknown_outcome' });
        expect(client.report).toHaveBeenCalledWith('script', { claimId: 'cx', status: 'failed', error: 'Daemon restarted while the script was running', needsAttention: true, attentionReason: 'daemon_restarted' });
        expect(runner.trackedRunIds()).toEqual(['session']);
        readTurn.mockResolvedValue({ ended: true, status: 'completed', error: null, answer: 'resumed fine', userSeq: 1, lastSeq: 3 });
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('session', { claimId: 'cs', status: 'done', sessionId: 's1', summary: 'resumed fine' });
    });
    it('keeps a deferred final report until the server accepts it', async () => {
        const client = fakeClient([claimed()]);
        const runner = start(client); await settled(runner);
        turning.add('s1'); await runner.tick(); turning.delete('s1');
        readTurn.mockResolvedValue({ ended: true, status: 'completed', error: null, answer: 'ok', userSeq: 1, lastSeq: 3 });
        client.report.mockRejectedValueOnce(new Error('network'));
        await runner.tick();
        expect(readReceipt(home, 'r1')?.phase).toBe('running');
        expect(runner.trackedRunIds()).toEqual(['r1']);
        await runner.tick();
        expect(client.report).toHaveBeenLastCalledWith('r1', { claimId: 'claim-1', status: 'done', sessionId: 's1', summary: 'ok' });
        expect(readReceipt(home, 'r1')?.phase).toBe('finished');
    });
    it('stays quiet on an old or gated server: one debug line per 10 minutes, no execution', async () => {
        const client = fakeClient();
        client.claim.mockRejectedValue(new AutomationsRequestError(404, 'automations_disabled'));
        const runner = start(client); await settled(runner);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toContain('unavailable');
        clock += 61_000; await runner.tick();
        clock += 61_000; await runner.tick();
        expect(log).toHaveBeenCalledTimes(1);
        expect(client.claim).toHaveBeenCalledTimes(3);
        clock += AUTOMATION_UNAVAILABLE_LOG_MS; await runner.tick();
        expect(log).toHaveBeenCalledTimes(2);
        client.claim.mockRejectedValue(new Error('offline'));
        clock += 61_000; await runner.tick();
        expect(log.mock.calls[2][0]).toContain('claim failed');
        expect(spawn).not.toHaveBeenCalled();
    });
});
