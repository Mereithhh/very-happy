import { describe, expect, it } from 'vitest';
import { autoRestartLabel, formatDaemonList } from './daemonListFormat';

const daemon = { version: '0.2.191', upgradePending: null, autoRestartEnabled: true };
const time = (ms: number) => `t${ms}`;

describe('B-856 daemon list: CLI version and auto-restart per session', () => {
    it('labels every published state with its reason and target', () => {
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.190', autoRestart: { state: 'waiting', reason: 'recent-activity', since: 1, target: '0.2.191' } }, daemon))
            .toBe('auto-restart: waiting (recent-activity) → 0.2.191');
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.190', autoRestart: { state: 'manual', reason: 'local-terminal', since: 1, target: '0.2.191' } }, daemon))
            .toBe('auto-restart: manual (local-terminal) → 0.2.191');
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.190', autoRestart: { state: 'failed', reason: 'spawn timeout', since: 1, target: '0.2.191', offline: true, retryAt: 5 } }, daemon, time))
            .toBe('auto-restart: failed (spawn timeout, offline, retry t5) → 0.2.191');
    });
    it('no status: current, behind and not yet evaluated, behind with the switch off, or an old daemon', () => {
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.191', autoRestart: null }, daemon)).toBe('current');
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.190', autoRestart: null }, daemon)).toBe('behind (not evaluated yet)');
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.190', autoRestart: null }, { ...daemon, autoRestartEnabled: false })).toBe('behind (auto-restart off)');
        expect(autoRestartLabel({ happySessionId: 's', pid: 1, cliVersion: '0.2.190' }, undefined)).toBe('auto-restart: unknown (daemon does not report it)');
    });
    it('a header with the daemon version, switch and pending upgrade, then one line per session', () => {
        expect(formatDaemonList([
            { happySessionId: 'a', pid: 11, cliVersion: '0.2.190', autoRestart: { state: 'waiting', reason: 'upgrade-pending', since: 1, target: '0.2.190' } },
            { happySessionId: 'b', pid: 12, autoRestart: null },
        ], { version: '0.2.190', upgradePending: '0.2.191', autoRestartEnabled: true })).toEqual([
            'Daemon 0.2.190 · auto-restart on · upgrade pending (0.2.191): automatic restarts wait for the new daemon',
            '  a  pid 11  cli 0.2.190  auto-restart: waiting (upgrade-pending) → 0.2.190',
            '  b  pid 12  cli ?  current',
        ]);
    });
    it('B-911: a queued restart-when-idle is shown with who asked and what it waits for', () => {
        const lines = formatDaemonList([
            { happySessionId: 's1', pid: 1, cliVersion: '0.2.181', autoRestart: { state: 'manual', reason: 'no-report', since: 0, target: '0.2.210' }, idleRestart: { source: 'owner', requestedAt: 0, wait: 'turn-active' } },
            { happySessionId: 's2', pid: 2, cliVersion: '0.2.210', autoRestart: null, idleRestart: { source: 'agent', requestedAt: 0, restarting: true } },
        ], { version: '0.2.210', upgradePending: null, autoRestartEnabled: true }, () => 'T');
        expect(lines[1]).toBe('  s1  pid 1  cli 0.2.181  auto-restart: manual (no-report) → 0.2.210  restart when idle: queued by owner T (waiting: turn-active)');
        expect(lines[2]).toBe('  s2  pid 2  cli 0.2.210  current  restart when idle: restarting');
    });
});
