import { describe, expect, it } from 'vitest';
import { RelayRegistry } from './relayRegistry';

describe('RelayRegistry', () => {
    it('scopes assignments by account and expires them', () => {
        const registry = new RelayRegistry(75_000);
        registry.claim({ accountId: 'a1', machineId: 'm1', relayId: 'sin', probes: [{ relayId: 'sin', rttMs: 10 }] }, 1_000);
        expect(registry.get('a1', 'm1', 75_999)?.relayId).toBe('sin');
        expect(registry.get('a2', 'm1', 2_000)).toBeNull();
        expect(registry.get('a1', 'm1', 76_001)).toBeNull();
    });
});
