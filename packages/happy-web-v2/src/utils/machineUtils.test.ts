import { describe, it, expect } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import { soleOnlineMachine, machineLabel, pickDefaultMachineId } from './machineUtils';

const M = (id: string, active: boolean, metadata: Machine['metadata'] = null): Machine => ({
    id,
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active,
    activeAt: 0,
    metadata,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
});

describe('soleOnlineMachine', () => {
    it('no machines → null (picker shows its empty state)', () => {
        expect(soleOnlineMachine([])).toBeNull();
    });

    it('machines exist but all offline → null (picker)', () => {
        expect(soleOnlineMachine([M('a', false), M('b', false)])).toBeNull();
    });

    it('exactly one online → that machine, even among offline ones', () => {
        const target = M('b', true);
        expect(soleOnlineMachine([M('a', false), target, M('c', false)])).toBe(target);
    });

    it('several online → null (ambiguous, picker decides)', () => {
        expect(soleOnlineMachine([M('a', true), M('b', true)])).toBeNull();
    });
});

describe('machineLabel', () => {
    it('prefers displayName, then host, then id prefix', () => {
        expect(machineLabel(M('m1', true, { displayName: 'Dev Box', host: 'devbox.local' } as any))).toBe('Dev Box');
        expect(machineLabel(M('m1', true, { host: 'devbox.local' } as any))).toBe('devbox.local');
        expect(machineLabel(M('0123456789abcdef', true))).toBe('01234567');
    });
});

describe('pickDefaultMachineId', () => {
    it('keeps the preferred machine when it is online', () => {
        expect(pickDefaultMachineId(['m1', 'm2'], 'm2')).toBe('m2');
    });

    it('falls back to the first online machine when the preferred one went offline', () => {
        expect(pickDefaultMachineId(['m1', 'm2'], 'gone')).toBe('m1');
    });

    it('returns empty when nothing is online', () => {
        expect(pickDefaultMachineId([], 'm1')).toBe('');
    });

    it('adopts the first machine once the store hydrates (B-146)', () => {
        // The dialog mounts before the machine store is ready, so its first
        // pick is made from an EMPTY list. Re-running with the arrived list and
        // the frozen '' must hand back a real machine — otherwise Create stays
        // disabled forever.
        const frozen = pickDefaultMachineId([], undefined);
        expect(frozen).toBe('');
        expect(pickDefaultMachineId(['m1', 'm2'], frozen)).toBe('m1');
    });

    it('is idempotent once a live machine is selected', () => {
        // Guards the re-derive effect against a setState loop.
        expect(pickDefaultMachineId(['m1', 'm2'], 'm2')).toBe('m2');
    });
});
