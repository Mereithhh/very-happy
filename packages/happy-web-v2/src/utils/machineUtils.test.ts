import { describe, it, expect } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import { soleOnlineMachine, machineLabel } from './machineUtils';

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
