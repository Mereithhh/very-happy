import { describe, expect, it } from 'vitest';
import { RelayRegistry, createRelayRegistryStore } from './relayRegistry';

describe('RelayRegistry', () => {
    it('scopes assignments by account and expires them', () => {
        const registry = new RelayRegistry(75_000);
        registry.claim({ accountId: 'a1', machineId: 'm1', relayId: 'sin', probes: [{ relayId: 'sin', rttMs: 10 }] }, 1_000);
        expect(registry.get('a1', 'm1', 75_999)?.relayId).toBe('sin');
        expect(registry.get('a2', 'm1', 2_000)).toBeNull();
        expect(registry.get('a1', 'm1', 76_001)).toBeNull();
    });
});

describe('Redis relay registry', () => {
    it('stores a shared expiring lease and preserves account isolation', async () => {
        const values = new Map<string, string>();
        const redis = {
            set: async (key: string, value: string) => { values.set(key, value); return 'OK'; },
            get: async (key: string) => values.get(key) ?? null,
            del: async (key: string) => { values.delete(key); return 1; },
        } as any;
        const registry = createRelayRegistryStore(() => redis, 75_000);
        await registry.claim({ accountId: 'a1', machineId: 'm1', relayId: 'sin', probes: [] }, 1_000);
        await expect(registry.get('a1', 'm1', 2_000)).resolves.toMatchObject({ relayId: 'sin' });
        await expect(registry.get('a2', 'm1', 2_000)).resolves.toBeNull();
        await expect(registry.get('a1', 'm1', 76_001)).resolves.toBeNull();
    });
});
