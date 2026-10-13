import { describe, expect, it } from 'vitest';
import { autoWakeKey, isHibernated, readMachineHibernation, shouldAutoWake, supportsKeepAwake, HIBERNATION_STAMP_SLACK_MS } from './sessionHibernation';
import { composerGate, canOfferRestore } from './sessionRestoreRules';

const meta = (extra: Record<string, unknown> = {}) => ({ path: '/p', host: 'h', flavor: 'claude', claudeSessionId: 'c1', machineId: 'm1', ...extra }) as never;
const stamp = { at: 10_000, seq: 4, idleMs: 3_600_000, v: 1 };
const hibernated = { active: false, archivedAt: null, activeAt: 9_000, metadata: meta({ hibernation: stamp }) };

describe('B-587 isHibernated', () => {
    it('offline + not archived + stamp → hibernated', () => {
        expect(isHibernated(hibernated)).toBe(true);
    });
    it('active, archived, plain offline, garbage stamp → not hibernated', () => {
        expect(isHibernated({ ...hibernated, active: true })).toBe(false);
        expect(isHibernated({ ...hibernated, archivedAt: 1 })).toBe(false);
        expect(isHibernated({ ...hibernated, metadata: meta() })).toBe(false);
        expect(isHibernated({ ...hibernated, metadata: meta({ hibernation: { at: 'x' } }) })).toBe(false);
        expect(isHibernated(null)).toBe(false);
    });
    it('a stamp an old CLI left behind (it heartbeat long after) is not hibernation', () => {
        expect(isHibernated({ ...hibernated, activeAt: stamp.at + HIBERNATION_STAMP_SLACK_MS + 1 })).toBe(false);
        expect(isHibernated({ ...hibernated, activeAt: stamp.at + 1000 })).toBe(true);
    });
});

describe('B-587 composer + restore surfaces', () => {
    it('a hibernated session composer restores first (queues), a merely offline one sends as before', () => {
        expect(composerGate(hibernated)).toBe('restore-first');
        expect(composerGate({ ...hibernated, metadata: meta() })).toBe('send');
        expect(composerGate({ ...hibernated, active: true })).toBe('send');
    });
    it('old-web view of the same row: offline, restorable with the existing Restore', () => {
        // canOfferRestore never looked at the stamp — this is exactly what an old web runs.
        expect(canOfferRestore(hibernated, { id: 'm1', active: true })).toBe(true);
    });
});

describe('B-587 capability gates', () => {
    it('keep-awake only for wrappers that advertise the capability', () => {
        expect(supportsKeepAwake({ capabilities: ['agent-hibernation-v1'] })).toBe(true);
        expect(supportsKeepAwake({ capabilities: ['prompt-queue-v1'] })).toBe(false);
        expect(supportsKeepAwake(null)).toBe(false);
    });
    it('machine setting only from THIS daemon run (detectedAt >= startedAt)', () => {
        expect(readMachineHibernation({ startedAt: 5, agentHibernation: { idleMs: 0, rpcAvailable: true, detectedAt: 5 } })).toEqual({ idleMs: 0 });
        expect(readMachineHibernation({ startedAt: 6, agentHibernation: { idleMs: 0, rpcAvailable: true, detectedAt: 5 } })).toBeNull();
        expect(readMachineHibernation({ startedAt: 5 })).toBeNull();
        expect(readMachineHibernation(null)).toBeNull();
    });
});

describe('B-587 auto-wake on open', () => {
    const base = { sessionId: 's1', session: hibernated, machineOnline: true, restoreBusy: false, attempted: new Set<string>(), openedAt: 20_000 };
    it('opening a hibernated session wakes it once per hibernation', () => {
        expect(shouldAutoWake(base)).toBe(autoWakeKey('s1', hibernated));
        expect(shouldAutoWake({ ...base, attempted: new Set([autoWakeKey('s1', hibernated)!]) })).toBeNull();
    });
    it('hibernating while the page is open does not wake it (the open tab would pin it awake)', () => {
        expect(shouldAutoWake({ ...base, openedAt: stamp.at - 1 })).toBeNull();
    });
    it('machine offline / restore already running / not hibernated → nothing', () => {
        expect(shouldAutoWake({ ...base, machineOnline: false })).toBeNull();
        expect(shouldAutoWake({ ...base, restoreBusy: true })).toBeNull();
        expect(shouldAutoWake({ ...base, session: { ...hibernated, active: true } })).toBeNull();
    });
});
