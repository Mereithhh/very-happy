import { describe, expect, it } from 'vitest';
import {
    DEFAULT_HIBERNATION_IDLE_MS,
    HOUR_MS,
    decideDaemonHibernation,
    evaluateWrapperIdle,
    hibernationReplaySeq,
    nextCheckDelay,
    reportSignature,
    resolveCheckMs,
    resolveIdleMs,
    settingIdleMs,
    type DaemonHibernationInput,
    type WrapperIdleSnapshot,
} from './hibernationPolicy';

const NOW = 100 * HOUR_MS;
const IDLE = 6 * HOUR_MS;

function idle(overrides: Partial<WrapperIdleSnapshot> = {}): WrapperIdleSnapshot {
    return {
        flavor: 'claude',
        resumable: true,
        uiSession: true,
        keepAwake: false,
        thinking: false,
        queuedInputs: 0,
        waitingForInput: true,
        pendingRequests: 0,
        backgroundTasks: 0,
        lastActivityAt: NOW - IDLE,
        ...overrides,
    };
}

describe('B-587 policy settings', () => {
    it('absent setting = 6h default, 0 = off, clamped to 1–24h', () => {
        expect(settingIdleMs(undefined)).toBe(DEFAULT_HIBERNATION_IDLE_MS);
        expect(settingIdleMs(0)).toBe(0);
        expect(settingIdleMs(-5)).toBe(0);
        expect(settingIdleMs(60_000)).toBe(HOUR_MS);
        expect(settingIdleMs(48 * HOUR_MS)).toBe(24 * HOUR_MS);
        expect(settingIdleMs('6h')).toBe(DEFAULT_HIBERNATION_IDLE_MS);
    });
    it('HAPPY_HIBERNATE_IDLE_MS overrides (seconds-level for tests); garbage falls back', () => {
        expect(resolveIdleMs(undefined, { HAPPY_HIBERNATE_IDLE_MS: '5000' })).toBe(5000);
        expect(resolveIdleMs(3 * HOUR_MS, { HAPPY_HIBERNATE_IDLE_MS: '0' })).toBe(0);
        expect(resolveIdleMs(3 * HOUR_MS, { HAPPY_HIBERNATE_IDLE_MS: 'x' })).toBe(3 * HOUR_MS);
        expect(resolveCheckMs({ HAPPY_HIBERNATE_CHECK_MS: '2000' })).toBe(2000);
        expect(resolveCheckMs({ HAPPY_HIBERNATE_CHECK_MS: '10' })).toBe(5 * 60 * 1000);
    });
});

describe('B-587 wrapper rules — each one alone keeps the session awake', () => {
    it('a fully idle UI session past the threshold may hibernate', () => {
        expect(evaluateWrapperIdle(idle(), IDLE, NOW)).toEqual({ ok: true });
    });
    const cases: Array<[string, Partial<WrapperIdleSnapshot>, string]> = [
        ['terminal / local session', { uiSession: false }, 'not-ui-session'],
        ['assistant variant', { variant: 'assistant' }, 'not-ui-session'],
        ['pi flavor (web cannot resume it)', { flavor: 'pi' }, 'unsupported-flavor'],
        ['no conversation id yet (never had a turn) — the web could not wake it', { resumable: false }, 'not-resumable'],
        ['spawned by an IM bridge', { spawnedBy: 'tanka' }, 'spawn-origin'],
        ['teams tag after a resume lost the env', { tags: ['teams'] }, 'spawn-origin'],
        ['automation tag', { tags: ['x', 'automation'] }, 'spawn-origin'],
        ['user said keep awake', { keepAwake: true }, 'keep-awake'],
        ['turn running', { thinking: true }, 'turn-active'],
        ['queued input', { queuedInputs: 1 }, 'queued-input'],
        ['runner not parked (turn not fully over)', { waitingForInput: false }, 'queued-input'],
        ['pending approval / question', { pendingRequests: 1 }, 'pending-request'],
        ['background task / async sub-agent', { backgroundTasks: 1 }, 'background-tasks'],
        ['activity 1ms too recent', { lastActivityAt: NOW - IDLE + 1 }, 'recent-activity'],
        ['already exiting for another reason', { exiting: true }, 'exiting'],
    ];
    for (const [name, override, reason] of cases) {
        it(name, () => {
            expect(evaluateWrapperIdle(idle(override), IDLE, NOW)).toEqual({ ok: false, reason });
        });
    }
    it('policy off', () => {
        expect(evaluateWrapperIdle(idle(), 0, NOW)).toEqual({ ok: false, reason: 'disabled' });
    });
    it('user tags that are not origin tags do not block', () => {
        expect(evaluateWrapperIdle(idle({ tags: ['bugfix'] }), IDLE, NOW)).toEqual({ ok: true });
    });
});

describe('B-587 daemon rules', () => {
    function input(overrides: Partial<DaemonHibernationInput> = {}): DaemonHibernationInput {
        const report = overrides.report ?? idle();
        return {
            idleMs: IDLE,
            now: NOW,
            sessionId: 's1',
            pid: 10,
            report,
            trackedLive: true,
            teamsMember: false,
            turnActive: false,
            backgroundTasks: 0,
            automationBound: new Set(),
            previousSignature: reportSignature(report),
            hibernationInFlight: false,
            ...overrides,
        };
    }
    it('everything holds → hibernate', () => {
        expect(decideDaemonHibernation(input())).toEqual({ ok: true });
    });
    const cases: Array<[string, Partial<DaemonHibernationInput>, string]> = [
        ['policy off', { idleMs: 0 }, 'disabled'],
        ['not a wrapper this daemon tracks', { trackedLive: false }, 'not-tracked'],
        ['Teams member', { teamsMember: true }, 'teams'],
        ['spawned by teams (tracked)', { trackedSpawnedBy: 'teams' }, 'teams'],
        ['spawned by assistant (tracked)', { trackedSpawnedBy: 'assistant' }, 'spawn-origin'],
        ['daemon sees a live turn lease', { turnActive: true }, 'turn-active'],
        ['daemon sees background tasks', { backgroundTasks: 2 }, 'background-tasks'],
        ['Automations reuse this session', { automationBound: new Set(['s1']) }, 'automation-bound'],
        ['Automations could not be read (fail closed)', { automationBound: null }, 'automations-unknown'],
        ['first sample only', { previousSignature: undefined }, 'unconfirmed'],
        ['state changed between samples', { previousSignature: 'other' }, 'unconfirmed'],
        ['another hibernation in flight', { hibernationInFlight: true }, 'busy'],
        ['wrapper says busy', { report: idle({ thinking: true }) }, 'turn-active'],
    ];
    for (const [name, override, reason] of cases) {
        it(name, () => {
            expect(decideDaemonHibernation(input(override))).toEqual({ ok: false, reason });
        });
    }
    it('next check waits out the remaining idle time, never less than the check period', () => {
        const report = { lastActivityAt: NOW - HOUR_MS };
        expect(nextCheckDelay({ ok: false, reason: 'recent-activity' }, report, IDLE, 60_000, NOW)).toBe(5 * HOUR_MS);
        expect(nextCheckDelay({ ok: false, reason: 'recent-activity' }, { lastActivityAt: NOW - IDLE + 10 }, IDLE, 60_000, NOW)).toBe(60_000);
        expect(nextCheckDelay({ ok: false, reason: 'teams' }, report, IDLE, 60_000, NOW)).toBe(60_000);
    });
});

describe('B-587 replay cursor', () => {
    it('replays only when records arrived after the stamp', () => {
        expect(hibernationReplaySeq({ hibernation: { at: 1, seq: 10, idleMs: 1, v: 1 } }, 12)).toBe(10);
        expect(hibernationReplaySeq({ hibernation: { at: 1, seq: 12, idleMs: 1, v: 1 } }, 12)).toBeNull();
        expect(hibernationReplaySeq({ hibernation: { at: 1, seq: -1 } }, 12)).toBeNull();
        expect(hibernationReplaySeq({}, 12)).toBeNull();
        expect(hibernationReplaySeq(null, 12)).toBeNull();
    });
});
