import { describe, expect, it } from 'vitest';
import {
    batchRestartIds,
    busyRefusal,
    daemonHasIdleGuard,
    batchRestartBlock,
    staleSessionSkip,
    staleSessionsForMachine,
    type StaleBatchSessionLike,
} from './staleSessionsBatch';
import type { MachineAutoRestart } from './autoRestartPolicy';

const machine = { active: true, daemonState: { startedWithCliVersion: '0.2.205' } };
const session = (id: string, over: Partial<StaleBatchSessionLike> = {}): StaleBatchSessionLike => ({
    id, active: true, archivedAt: null, thinking: false,
    metadata: { machineId: 'm1', version: '0.2.181', flavor: 'claude', tags: [] },
    agentState: { requests: {} },
    ...over,
});
const none = { backgroundTasks: () => 0, autoRestart: null, restarting: () => false };

describe('B-894 staleSessionsForMachine', () => {
    it('lists only this machine\'s live sessions on an older CLI', () => {
        const list = staleSessionsForMachine('m1', machine, [
            session('old'),
            session('current', { metadata: { machineId: 'm1', version: '0.2.205' } }),
            session('other-machine', { metadata: { machineId: 'm2', version: '0.2.181' } }),
            session('offline', { active: false }),
            session('archived', { archivedAt: 1 }),
            session('mirror', { metadata: { machineId: 'm1', version: '0.2.181', flavor: 'terminal-mirror' } }),
        ], none);
        expect(list.map((e) => e.id)).toEqual(['old']);
        expect(list[0].notice).toMatchObject({ sessionVersion: '0.2.181', machineVersion: '0.2.205' });
    });
    it('a team session is listed but not pre-selected; a plain idle one is', () => {
        const list = staleSessionsForMachine('m1', machine, [
            session('lead', { metadata: { machineId: 'm1', version: '0.2.181', tags: ['teams'] } }),
            session('plain'),
        ], none);
        expect(list.map((e) => [e.id, e.team, e.defaultSelected])).toEqual([['plain', false, true], ['lead', true, false]]);
    });
    it('busy sessions are skipped with the reason and never pre-selected', () => {
        const list = staleSessionsForMachine('m1', machine, [
            session('turn', { thinking: true }),
            session('approval', { agentState: { requests: { r1: {} } } }),
            session('bg'),
            session('idle'),
        ], { ...none, backgroundTasks: (id) => (id === 'bg' ? 1 : 0) });
        expect(Object.fromEntries(list.map((e) => [e.id, e.skip]))).toEqual({ idle: null, turn: 'turn-active', approval: 'pending-request', bg: 'background-tasks' });
        expect(list.filter((e) => e.defaultSelected).map((e) => e.id)).toEqual(['idle']);
        expect(list[0].id).toBe('idle'); // restartable first
    });
});

describe('B-894 staleSessionSkip', () => {
    const ar = (sessions: MachineAutoRestart['sessions']): MachineAutoRestart => ({ enabled: true, sessions, startedAt: 0 });
    it('uses agentState background tasks and the daemon\'s busy reasons too', () => {
        expect(staleSessionSkip(session('a', { agentState: { backgroundTasks: { tasks: [{}] } } }), { backgroundTasks: 0, autoRestart: null, restarting: false })).toBe('background-tasks');
        expect(staleSessionSkip(session('a'), { backgroundTasks: 0, autoRestart: ar({ a: { state: 'waiting', reason: 'turn-active', since: 0, target: 'x' } }), restarting: false })).toBe('turn-active');
        expect(staleSessionSkip(session('a'), { backgroundTasks: 0, autoRestart: ar({ a: { state: 'manual', reason: 'no-report', since: 0, target: 'x' } }), restarting: false })).toBeNull();
        expect(staleSessionSkip(session('a'), { backgroundTasks: 0, autoRestart: ar({ a: { state: 'restarting', since: 0, target: 'x' } }), restarting: false })).toBe('restarting');
        expect(staleSessionSkip(session('a'), { backgroundTasks: 0, autoRestart: null, restarting: true })).toBe('restarting');
    });
});

describe('B-894 batchRestartIds / daemon guard', () => {
    it('restarts checked AND restartable only', () => {
        const list = staleSessionsForMachine('m1', machine, [session('a'), session('b', { thinking: true }), session('c')], none);
        expect(batchRestartIds(list, new Set(['a', 'b']))).toEqual(['a']);
    });
    it('idleGuard capability and busy refusals', () => {
        expect(daemonHasIdleGuard({ autoRestart: { idleGuard: true } })).toBe(true);
        expect(daemonHasIdleGuard({ autoRestart: {} })).toBe(false);
        expect(daemonHasIdleGuard(null)).toBe(false);
        expect(busyRefusal('busy:turn-active')).toBe('turn-active');
        expect(busyRefusal('busy:background-tasks')).toBe('background-tasks');
        expect(busyRefusal('restart:too-many')).toBeNull();
        expect(busyRefusal(undefined)).toBeNull();
    });
});

describe('B-894c batch restart needs the daemon idle guard', () => {
    const guarded = { autoRestart: { idleGuard: true } };
    it('an old daemon (no idleGuard) disables the batch even with idle sessions checked', () => {
        expect(batchRestartBlock({ online: true, daemonState: {}, count: 3, running: false })).toBe('needs-cli-upgrade');
        expect(batchRestartBlock({ online: true, daemonState: { autoRestart: { idleGuard: false } }, count: 3, running: false })).toBe('needs-cli-upgrade');
        expect(batchRestartBlock({ online: true, daemonState: null, count: 1, running: false })).toBe('needs-cli-upgrade');
    });
    it('a guarded daemon allows it; offline / nothing checked / running still block', () => {
        expect(batchRestartBlock({ online: true, daemonState: guarded, count: 2, running: false })).toBeNull();
        expect(batchRestartBlock({ online: false, daemonState: guarded, count: 2, running: false })).toBe('offline');
        expect(batchRestartBlock({ online: true, daemonState: guarded, count: 0, running: false })).toBe('none-selected');
        expect(batchRestartBlock({ online: true, daemonState: guarded, count: 2, running: true })).toBe('running');
    });
});
