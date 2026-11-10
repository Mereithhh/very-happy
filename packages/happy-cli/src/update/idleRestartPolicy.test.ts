import { describe, expect, it } from 'vitest';
import {
    AGENT_RESTART_COOLDOWN_MS, AGENT_RESTART_WINDOW_MS, IDLE_RESTART_OBSERVE_MS, IDLE_RESTART_QUIET_MS,
    agentRestartRefusal, claudeRunIntentFromArgv, idleRestartReady, resolveIdleRestartTiming, takeRestartEffort,
    takeRestartedOnRequestEvent, wrapperReportsTurns, RESTART_EFFORT_ENV, RESTARTED_ON_REQUEST_ENV,
} from './idleRestartPolicy';
import { takeAutoRestartedEvent } from './autoRestartPolicy';

const base = { now: 1_000_000, requestedAt: 1_000_000 - IDLE_RESTART_OBSERVE_MS, turnActive: false, backgroundTasks: 0, automationRunning: false, upgradePending: null, lastTurnEventAt: null, lastTurnEndedAt: null };

describe('B-911 idleRestartReady', () => {
    it('idle only with no turn lease, no background work, no upgrade, a quiet spell and a full observation window', () => {
        expect(idleRestartReady(base)).toEqual({ ready: true });
        expect(idleRestartReady({ ...base, turnActive: true })).toEqual({ ready: false, wait: 'turn-active' });
        expect(idleRestartReady({ ...base, backgroundTasks: 1 })).toEqual({ ready: false, wait: 'background-tasks' });
        expect(idleRestartReady({ ...base, automationRunning: true })).toEqual({ ready: false, wait: 'automation-run' });
        expect(idleRestartReady({ ...base, upgradePending: '0.2.300' })).toEqual({ ready: false, wait: 'upgrade-pending' });
        expect(idleRestartReady({ ...base, lastTurnEventAt: base.now - IDLE_RESTART_QUIET_MS + 1 })).toEqual({ ready: false, wait: 'quiet' });
        expect(idleRestartReady({ ...base, lastTurnEventAt: base.now - IDLE_RESTART_QUIET_MS })).toEqual({ ready: true });
    });

    it('right after the request it waits one lease window (a running turn renews within it) unless a turn_ended came after the request', () => {
        const fresh = { ...base, requestedAt: base.now - 10_000 };
        expect(idleRestartReady(fresh)).toEqual({ ready: false, wait: 'observing' });
        expect(idleRestartReady({ ...fresh, lastTurnEndedAt: fresh.requestedAt - 1, lastTurnEventAt: fresh.requestedAt - IDLE_RESTART_QUIET_MS })).toEqual({ ready: false, wait: 'observing' });
        expect(idleRestartReady({ ...fresh, now: base.now + IDLE_RESTART_QUIET_MS, lastTurnEndedAt: fresh.requestedAt + 1, lastTurnEventAt: fresh.requestedAt + 1 })).toEqual({ ready: true });
        expect(IDLE_RESTART_OBSERVE_MS).toBeGreaterThan(60_000);
    });

    it('test knobs', () => {
        expect(resolveIdleRestartTiming({})).toEqual({ quietMs: IDLE_RESTART_QUIET_MS, observeMs: IDLE_RESTART_OBSERVE_MS, checkMs: 10_000 });
        expect(resolveIdleRestartTiming({ HAPPY_IDLE_RESTART_QUIET_MS: '2000', HAPPY_IDLE_RESTART_OBSERVE_MS: '5000', HAPPY_IDLE_RESTART_CHECK_MS: '10' })).toEqual({ quietMs: 2000, observeMs: 5000, checkMs: 1000 });
    });
});

describe('B-911 agent restart limits', () => {
    const now = 10 * AGENT_RESTART_WINDOW_MS;
    it('3 accepted per rolling 24 h, none within 10 min of the last restart', () => {
        expect(agentRestartRefusal({ now, accepted: [], lastRestartAt: null })).toBeNull();
        expect(agentRestartRefusal({ now, accepted: [now - 1000, now - 2000], lastRestartAt: null })).toBeNull();
        expect(agentRestartRefusal({ now, accepted: [now - 1000, now - 2000, now - 3000], lastRestartAt: null })).toEqual({ code: 'rate-limited', retryAfterMs: AGENT_RESTART_WINDOW_MS - 3000 });
        expect(agentRestartRefusal({ now, accepted: [now - AGENT_RESTART_WINDOW_MS, now - 2000, now - 3000], lastRestartAt: null })).toBeNull();
        expect(agentRestartRefusal({ now, accepted: [], lastRestartAt: now - 60_000 })).toEqual({ code: 'cooldown', retryAfterMs: AGENT_RESTART_COOLDOWN_MS - 60_000 });
        expect(agentRestartRefusal({ now, accepted: [], lastRestartAt: now - AGENT_RESTART_COOLDOWN_MS })).toBeNull();
    });
});

describe('B-911 old-wrapper run intent and markers', () => {
    it('reads --model / --effort from the Claude child command line (both forms), ignoring junk', () => {
        expect(claudeRunIntentFromArgv(['claude', '--output-format', 'stream-json', '--effort=xhigh', '--model=claude-opus-5-5', '--resume=x'])).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
        expect(claudeRunIntentFromArgv(['--model', 'opus[1m]', '--effort', 'max'])).toEqual({ model: 'opus[1m]', effort: 'max' });
        expect(claudeRunIntentFromArgv(['--model=$(rm -rf)', '--effort=ultra'])).toEqual({});
        expect(claudeRunIntentFromArgv([])).toEqual({});
    });
    it('turn reports exist from 0.2.139', () => {
        expect(wrapperReportsTurns('0.2.181')).toBe(true);
        expect(wrapperReportsTurns('0.2.139')).toBe(true);
        expect(wrapperReportsTurns('0.2.138')).toBe(false);
        expect(wrapperReportsTurns(null)).toBe(false);
    });
    it('the effort env and the requested marker are read once and removed', () => {
        const env: NodeJS.ProcessEnv = { [RESTART_EFFORT_ENV]: 'xhigh', [RESTARTED_ON_REQUEST_ENV]: '0.2.210' };
        expect(takeRestartEffort(env)).toBe('xhigh');
        expect(env[RESTART_EFFORT_ENV]).toBeUndefined();
        expect(takeRestartEffort({ [RESTART_EFFORT_ENV]: 'bogus' })).toBeNull();
        expect(takeAutoRestartedEvent(env)).toEqual({ type: 'message', kind: 'session-restarted-on-request', message: "Restarted in place at the agent's request on Very Happy 0.2.210 (history kept)" });
        expect(env[RESTARTED_ON_REQUEST_ENV]).toBeUndefined();
        expect(takeRestartedOnRequestEvent({})).toBeNull();
    });
});
