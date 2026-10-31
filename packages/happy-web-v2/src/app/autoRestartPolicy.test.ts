import { describe, expect, it } from 'vitest';
import {
    AUTO_RESTART_CLASSIFY_GRACE_MS,
    AUTO_RESTART_LONG_WAIT_MS,
    failureSummary,
    offlineAutoRestartFailure,
    parseAutoUpdatedLine,
    readMachineAutoRestart,
    restartBannerMode,
    waitReasonKey,
} from './autoRestartPolicy';

const NOW = 1_000_000_000;
const state = (autoRestart: unknown, startedAt = NOW - AUTO_RESTART_CLASSIFY_GRACE_MS - 1) => ({ startedAt, autoRestart });
const ar = (sessions: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ enabled: true, rpcAvailable: true, detectedAt: NOW, sessions, ...extra });

describe('B-852 readMachineAutoRestart', () => {
    it('reads this run\'s capability and drops malformed entries', () => {
        expect(readMachineAutoRestart(state(ar({ a: { state: 'waiting', since: 1, target: '0.2.190', reason: 'turn-active' }, bad: { state: 1 } }))))
            .toEqual({ enabled: true, startedAt: NOW - AUTO_RESTART_CLASSIFY_GRACE_MS - 1, sessions: { a: { state: 'waiting', since: 1, target: '0.2.190', reason: 'turn-active' } } });
    });
    it('old daemon, previous run, or no rpc → null', () => {
        expect(readMachineAutoRestart({ startedAt: 1 })).toBeNull();
        expect(readMachineAutoRestart(state(ar({}, { detectedAt: 5 }), 10))).toBeNull();
        expect(readMachineAutoRestart(state(ar({}, { rpcAvailable: false })))).toBeNull();
        expect(readMachineAutoRestart(null)).toBeNull();
    });
});

describe('B-852 restartBannerMode', () => {
    const read = (sessions: Record<string, unknown>, extra: Record<string, unknown> = {}, startedAt?: number) => readMachineAutoRestart(state(ar(sessions, extra), startedAt));
    it('old daemon / switch off → manual (today\'s banner)', () => {
        expect(restartBannerMode('a', null, NOW)).toEqual({ kind: 'manual' });
        expect(restartBannerMode('a', read({ a: { state: 'restarting', since: NOW, target: 'x' } }, { enabled: false }), NOW)).toEqual({ kind: 'manual' });
    });
    it('restarting and short waits are automatic; long waits explain; failures and manual hand back', () => {
        expect(restartBannerMode('a', read({ a: { state: 'restarting', since: NOW, target: 'x' } }), NOW)).toEqual({ kind: 'auto' });
        expect(restartBannerMode('a', read({ a: { state: 'waiting', reason: 'turn-active', since: NOW - AUTO_RESTART_LONG_WAIT_MS + 1, target: 'x' } }), NOW)).toEqual({ kind: 'auto' });
        expect(restartBannerMode('a', read({ a: { state: 'waiting', reason: 'turn-active', since: NOW - AUTO_RESTART_LONG_WAIT_MS, target: 'x' } }), NOW)).toEqual({ kind: 'waiting', reason: 'turn-active' });
        expect(restartBannerMode('a', read({ a: { state: 'failed', reason: 'boom', since: NOW, target: 'x' } }), NOW)).toEqual({ kind: 'failed', reason: 'boom' });
        expect(restartBannerMode('a', read({ a: { state: 'manual', reason: 'no-report', since: NOW, target: 'x' } }), NOW)).toEqual({ kind: 'manual', reason: 'no-report' });
        // QA25 P2-1: a terminal session is manual at once and says why.
        expect(restartBannerMode('a', read({ a: { state: 'manual', reason: 'local-terminal', since: NOW, target: 'x' } }), NOW)).toEqual({ kind: 'manual', reason: 'local-terminal' });
        expect(restartBannerMode('a', read({ a: { state: 'something-new', since: NOW, target: 'x' } }), NOW)).toEqual({ kind: 'manual' });
    });
    it('unlisted: quiet during the classification grace, manual afterwards or when the daemon may not know', () => {
        expect(restartBannerMode('a', read({}, {}, NOW - 1000), NOW)).toEqual({ kind: 'auto' });
        expect(restartBannerMode('a', read({}), NOW)).toEqual({ kind: 'manual' });
        expect(restartBannerMode('a', read({}, {}, NOW - 1000), NOW, 'manual')).toEqual({ kind: 'manual' });
    });
});

describe('QA25 P2-2 offlineAutoRestartFailure', () => {
    const read = (sessions: Record<string, unknown>) => readMachineAutoRestart(state(ar(sessions)));
    it('only an offline failure, with its reason and the retry time when one is scheduled', () => {
        expect(offlineAutoRestartFailure('a', read({ a: { state: 'failed', reason: 'boom', since: 1, target: 'x', offline: true, retryAt: 5 } }))).toEqual({ reason: 'boom', retryAt: 5 });
        expect(offlineAutoRestartFailure('a', read({ a: { state: 'failed', reason: 'boom', since: 1, target: 'x', offline: true } }))).toEqual({ reason: 'boom', retryAt: null });
        expect(offlineAutoRestartFailure('a', read({ a: { state: 'failed', reason: 'boom', since: 1, target: 'x' } }))).toBeNull();
        expect(offlineAutoRestartFailure('a', read({ a: { state: 'waiting', since: 1, target: 'x', offline: true } }))).toBeNull();
        expect(offlineAutoRestartFailure('a', null)).toBeNull();
    });
});

describe('B-852 texts', () => {
    it('wait reasons map to known keys, anything else is generic', () => {
        expect(waitReasonKey('background-tasks')).toBe('background-tasks');
        expect(waitReasonKey('awaiting-check-in')).toBe('other');
    });
    it('failure text is shortened', () => {
        expect(failureSummary('restart-precheck:cwd-missing: /a/b')).toBe('cwd-missing');
        expect(failureSummary('x'.repeat(200))).toHaveLength(118);
    });
    it('parses the wrapper\'s service line (CLI and agent update)', () => {
        expect(parseAutoUpdatedLine('Updated to Very Happy 0.2.190 (session restarted in place, history kept)')).toEqual({ agent: null, version: '0.2.190' });
        expect(parseAutoUpdatedLine('Updated Codex to 0.155.0 (session restarted in place, history kept)')).toEqual({ agent: 'Codex', version: '0.155.0' });
        expect(parseAutoUpdatedLine('hello')).toBeNull();
    });
});
