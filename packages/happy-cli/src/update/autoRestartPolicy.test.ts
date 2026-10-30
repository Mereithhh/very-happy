import { describe, expect, it } from 'vitest';
import {
    AUTO_RESTART_BACKOFF_MS,
    AUTO_RESTART_MIN_GAP_MS,
    AUTO_RESTART_QUIET_MS,
    autoRestartNextCheck,
    autoUpdatedEventText,
    decideAutoRestart,
    decodeAutoRestarted,
    encodeAutoRestarted,
    recordAttempt,
    resolveQuietMs,
    statusFromVerdict,
    takeAutoRestartedEvent,
    wrapperReportsIdle,
    wrapperStaleness,
    type AutoRestartInput,
} from './autoRestartPolicy';
import type { WrapperIdleSnapshot } from '@/hibernation/hibernationPolicy';

const NOW = 100 * 60 * 1000;
const report = (overrides: Partial<WrapperIdleSnapshot> = {}): WrapperIdleSnapshot => ({
    flavor: 'claude', resumable: true, uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0,
    waitingForInput: true, pendingRequests: 0, backgroundTasks: 0, lastActivityAt: NOW - AUTO_RESTART_QUIET_MS, ...overrides,
});
const input = (overrides: Partial<AutoRestartInput> = {}): AutoRestartInput => ({
    enabled: true,
    now: NOW,
    staleness: { kind: 'cli', from: '0.2.188', target: '0.2.190' },
    trackedLive: true,
    report: report(),
    turnActive: false,
    backgroundTasks: 0,
    automationRunning: false,
    resumable: true,
    attempt: null,
    inFlight: 0,
    lastStartedAt: null,
    ...overrides,
});

describe('B-852 wrapperStaleness', () => {
    it('wrapper CLI behind the daemon', () => {
        expect(wrapperStaleness({ wrapperVersion: '0.2.188', daemonVersion: '0.2.190' })).toEqual({ kind: 'cli', from: '0.2.188', target: '0.2.190' });
    });
    it('same / newer / unparsable is never behind', () => {
        expect(wrapperStaleness({ wrapperVersion: '0.2.190', daemonVersion: '0.2.190' })).toBeNull();
        expect(wrapperStaleness({ wrapperVersion: '0.2.191', daemonVersion: '0.2.190' })).toBeNull();
        expect(wrapperStaleness({ wrapperVersion: 'garbage', daemonVersion: '0.2.190' })).toBeNull();
        expect(wrapperStaleness({ wrapperVersion: undefined, daemonVersion: '0.2.190' })).toBeNull();
    });
    it('Codex started on an older binary than the installed one (B-487 codex restart)', () => {
        expect(wrapperStaleness({ wrapperVersion: '0.2.190', daemonVersion: '0.2.190', agentVersion: '0.154.0', installedAgentVersion: '0.155.0' }))
            .toEqual({ kind: 'agent', from: '0.154.0', target: '0.155.0' });
        expect(wrapperStaleness({ wrapperVersion: '0.2.190', daemonVersion: '0.2.190', agentVersion: '0.155.0', installedAgentVersion: '0.155.0' })).toBeNull();
        expect(wrapperStaleness({ wrapperVersion: '0.2.190', daemonVersion: '0.2.190', agentVersion: '0.154.0', installedAgentVersion: null })).toBeNull();
    });
});

describe('B-852 decideAutoRestart — every safety condition (spec §2)', () => {
    it('all conditions hold → restart', () => {
        expect(decideAutoRestart(input())).toEqual({ ok: true });
    });
    const cases: Array<[string, Partial<AutoRestartInput>, string]> = [
        ['machine switch off', { enabled: false }, 'disabled'],
        ['wrapper current', { staleness: null }, 'not-stale'],
        ['daemon does not track it', { trackedLive: false }, 'not-tracked'],
        ['wrapper exiting', { report: report({ exiting: true }) }, 'exiting'],
        ['local terminal mode', { report: report({ uiSession: false }) }, 'local-terminal'],
        ['assistant variant', { report: report({ variant: 'assistant' }) }, 'assistant'],
        ['gemini', { report: report({ flavor: 'gemini' }) }, 'unsupported-flavor'],
        ['conversation not on disk', { resumable: false }, 'not-resumable'],
        ['wrapper thinking', { report: report({ thinking: true }) }, 'turn-active'],
        ['daemon turn lease', { turnActive: true }, 'turn-active'],
        ['permission request pending', { report: report({ pendingRequests: 1 }) }, 'pending-request'],
        ['message queued', { report: report({ queuedInputs: 1 }) }, 'queued-input'],
        ['runner not parked', { report: report({ waitingForInput: false }) }, 'queued-input'],
        ['background shell (wrapper)', { report: report({ backgroundTasks: 1 }) }, 'background-tasks'],
        ['background task (daemon lease)', { backgroundTasks: 2 }, 'background-tasks'],
        ['scheduled wakeup', { report: report({ scheduledWakeups: 1 }) }, 'scheduled-wakeup'],
        ['user active 9m ago', { report: report({ lastActivityAt: NOW - AUTO_RESTART_QUIET_MS + 60_000 }) }, 'recent-activity'],
        ['automation run in flight', { automationRunning: true }, 'automation-running'],
        ['gave up', { attempt: { target: '0.2.190', attempts: 2, notBefore: 0 } }, 'gave-up'],
        ['in backoff', { attempt: { target: '0.2.190', attempts: 1, notBefore: NOW + 1 } }, 'backoff'],
        ['another restart running', { inFlight: 1 }, 'machine-busy'],
        ['last restart 5s ago', { lastStartedAt: NOW - 5_000 }, 'machine-busy'],
    ];
    for (const [name, overrides, reason] of cases) {
        it(`${name} → ${reason}`, () => {
            expect(decideAutoRestart(input(overrides))).toEqual({ ok: false, reason });
        });
    }
    it('teams / automation spawn origin, keep-awake and pi are fine when idle', () => {
        expect(decideAutoRestart(input({ report: report({ spawnedBy: 'teams' }) }))).toEqual({ ok: true });
        expect(decideAutoRestart(input({ report: report({ tags: ['automation'] }) }))).toEqual({ ok: true });
        expect(decideAutoRestart(input({ report: report({ keepAwake: true }) }))).toEqual({ ok: true });
        expect(decideAutoRestart(input({ report: report({ flavor: 'acp' }) }))).toEqual({ ok: true });
        expect(decideAutoRestart(input({ report: report({ flavor: 'codex' }) }))).toEqual({ ok: true });
    });
    it('an attempt for an older target does not count against the new one', () => {
        expect(decideAutoRestart(input({ attempt: { target: '0.2.189', attempts: 2, notBefore: NOW + 1 } }))).toEqual({ ok: true });
    });
    it('exactly N minutes quiet and exactly the gap since the last restart pass', () => {
        expect(decideAutoRestart(input({ lastStartedAt: NOW - AUTO_RESTART_MIN_GAP_MS }))).toEqual({ ok: true });
    });
});

describe('B-852 pacing and backoff', () => {
    it('recent activity → ask again at the quiet point', () => {
        const i = input({ report: report({ lastActivityAt: NOW - 60_000 }) });
        expect(autoRestartNextCheck(decideAutoRestart(i), i)).toBe(AUTO_RESTART_QUIET_MS - 60_000);
    });
    it('machine busy → 15–45 s with jitter', () => {
        const i = input({ inFlight: 1 });
        expect(autoRestartNextCheck(decideAutoRestart(i), i, 0)).toBe(AUTO_RESTART_MIN_GAP_MS);
        expect(autoRestartNextCheck(decideAutoRestart(i), i, 0.5)).toBe(2 * AUTO_RESTART_MIN_GAP_MS);
    });
    it('other refusals leave the cadence to hibernation', () => {
        const i = input({ report: report({ pendingRequests: 1 }) });
        expect(autoRestartNextCheck(decideAutoRestart(i), i)).toBeNull();
    });
    it('failures back off then give up; success clears; never a loop', () => {
        const first = recordAttempt(null, '0.2.190', false, NOW, 'boom');
        expect(first).toEqual({ target: '0.2.190', attempts: 1, notBefore: NOW + AUTO_RESTART_BACKOFF_MS, lastError: 'boom' });
        expect(decideAutoRestart(input({ attempt: first }))).toEqual({ ok: false, reason: 'backoff' });
        const second = recordAttempt(first, '0.2.190', false, NOW + AUTO_RESTART_BACKOFF_MS, 'boom2');
        expect(second?.attempts).toBe(2);
        expect(decideAutoRestart(input({ now: NOW + 10 * AUTO_RESTART_BACKOFF_MS, attempt: second }))).toEqual({ ok: false, reason: 'gave-up' });
        expect(recordAttempt(first, '0.2.190', true, NOW)).toBeNull();
    });
});

describe('B-852 published status', () => {
    const staleness = { kind: 'cli' as const, from: '0.2.188', target: '0.2.190' };
    it('waiting keeps its first-seen time; terminal blockers are handed to the user', () => {
        const prev = { state: 'waiting' as const, reason: 'recent-activity', since: 5, target: '0.2.190' };
        expect(statusFromVerdict({ ok: false, reason: 'background-tasks' }, prev, staleness, NOW, null)).toEqual({ state: 'waiting', reason: 'background-tasks', since: 5, target: '0.2.190' });
        expect(statusFromVerdict({ ok: false, reason: 'local-terminal' }, undefined, staleness, NOW, null)?.state).toBe('manual');
        expect(statusFromVerdict({ ok: false, reason: 'not-resumable' }, undefined, staleness, NOW, null)?.state).toBe('manual');
        expect(statusFromVerdict({ ok: false, reason: 'gave-up' }, undefined, staleness, NOW, { target: '0.2.190', attempts: 2, notBefore: 0, lastError: 'spawn timeout' }))
            .toEqual({ state: 'failed', reason: 'spawn timeout', since: NOW, target: '0.2.190' });
        expect(statusFromVerdict({ ok: false, reason: 'disabled' }, undefined, staleness, NOW, null)).toBeNull();
    });
    it('which wrappers can ever prove themselves idle', () => {
        expect(wrapperReportsIdle({ flavor: 'claude', capabilities: ['agent-hibernation-v1'] })).toBe(true);
        expect(wrapperReportsIdle({ flavor: 'claude', capabilities: ['agent-hibernation-v1'], spawnedBy: 'teams' })).toBe(false);
        expect(wrapperReportsIdle({ flavor: 'codex', capabilities: ['agent-hibernation-v1'], tags: ['automation'] })).toBe(false);
        expect(wrapperReportsIdle({ flavor: 'claude', capabilities: ['agent-hibernation-v1', 'auto-restart-v1'], spawnedBy: 'teams' })).toBe(true);
        expect(wrapperReportsIdle({ flavor: 'acp', capabilities: ['auto-restart-v1'] })).toBe(true);
        expect(wrapperReportsIdle({ flavor: 'acp', capabilities: [] })).toBe(false);
        expect(wrapperReportsIdle({ flavor: 'claude', capabilities: null })).toBe(false);
        expect(wrapperReportsIdle({ flavor: 'claude', capabilities: ['auto-restart-v1'], variant: 'assistant' })).toBe(false);
    });
});

describe('B-852 restarted marker → service line', () => {
    it('round-trips and is removed from the env so the agent never inherits it', () => {
        expect(decodeAutoRestarted(encodeAutoRestarted('cli', '0.2.190'))).toEqual({ kind: 'cli', target: '0.2.190' });
        expect(decodeAutoRestarted('nope')).toBeNull();
        const env: NodeJS.ProcessEnv = { HAPPY_AUTO_RESTARTED: 'cli:0.2.190' };
        expect(takeAutoRestartedEvent(env)).toEqual({ type: 'message', kind: 'session-auto-updated', message: autoUpdatedEventText('cli', '0.2.190') });
        expect(env.HAPPY_AUTO_RESTARTED).toBeUndefined();
        expect(takeAutoRestartedEvent({})).toBeNull();
        expect(autoUpdatedEventText('agent', '0.155.0')).toBe('Updated Codex to 0.155.0 (session restarted in place, history kept)');
    });
});

describe('B-852 quiet window override (tests only)', () => {
    it('env wins when it is a non-negative number; the default otherwise', () => {
        expect(resolveQuietMs({ HAPPY_AUTO_RESTART_QUIET_MS: '90000' })).toBe(90000);
        expect(resolveQuietMs({ HAPPY_AUTO_RESTART_QUIET_MS: '-1' })).toBe(AUTO_RESTART_QUIET_MS);
        expect(resolveQuietMs({})).toBe(AUTO_RESTART_QUIET_MS);
        expect(decideAutoRestart(input({ quietMs: 60_000, report: report({ lastActivityAt: NOW - 60_000 }) }))).toEqual({ ok: true });
    });
});
