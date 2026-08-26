import type { ServerRelayProbe } from './relaySchemas';
import { getCoordinationRedis } from '@/app/release/redisCoordination';

export type RelayMachineLease = {
    accountId: string;
    machineId: string;
    relayId: string;
    probes: ServerRelayProbe[];
    updatedAt: number;
};

export class RelayRegistry {
    private readonly leases = new Map<string, RelayMachineLease>();

    constructor(private readonly ttlMs: number) {}

    claim(lease: Omit<RelayMachineLease, 'updatedAt'>, now = Date.now()): RelayMachineLease {
        const stored = { ...lease, probes: lease.probes.map((probe) => ({ ...probe })), updatedAt: now };
        this.leases.set(lease.machineId, stored);
        return stored;
    }

    get(accountId: string, machineId: string, now = Date.now()): RelayMachineLease | null {
        const lease = this.leases.get(machineId);
        if (!lease) return null;
        if (lease.accountId !== accountId || now - lease.updatedAt > this.ttlMs) {
            if (now - lease.updatedAt > this.ttlMs) this.leases.delete(machineId);
            return null;
        }
        return { ...lease, probes: lease.probes.map((probe) => ({ ...probe })) };
    }

    remove(machineId: string): void {
        this.leases.delete(machineId);
    }
}

export interface RelayRegistryStore {
    claim(lease: Omit<RelayMachineLease, 'updatedAt'>, now?: number): Promise<RelayMachineLease>;
    get(accountId: string, machineId: string, now?: number): Promise<RelayMachineLease | null>;
}

const REDIS_PREFIX = 'vh:relay-machine:';

function cloneLease(lease: RelayMachineLease): RelayMachineLease {
    return { ...lease, probes: lease.probes.map((probe) => ({ ...probe })) };
}

function parseStoredLease(value: string | null): RelayMachineLease | null {
    if (!value) return null;
    try {
        const lease = JSON.parse(value) as Partial<RelayMachineLease>;
        if (typeof lease.accountId !== 'string' || typeof lease.machineId !== 'string'
            || typeof lease.relayId !== 'string' || typeof lease.updatedAt !== 'number'
            || !Array.isArray(lease.probes)) return null;
        return cloneLease(lease as RelayMachineLease);
    } catch {
        return null;
    }
}

/**
 * Cloud replicas share relay assignments through Redis. Standalone mode keeps
 * the original in-memory registry and does not acquire a Redis dependency.
 */
export function createRelayRegistryStore(
    redisProvider: typeof getCoordinationRedis,
    ttlMs = 75_000,
): RelayRegistryStore {
    const memoryRegistry = new RelayRegistry(ttlMs);
    return {
        async claim(lease, now = Date.now()) {
            const stored = { ...lease, probes: lease.probes.map((probe) => ({ ...probe })), updatedAt: now };
            const redis = redisProvider();
            if (!redis) return memoryRegistry.claim(lease, now);
            await redis.set(`${REDIS_PREFIX}${lease.machineId}`, JSON.stringify(stored), 'PX', ttlMs);
            return cloneLease(stored);
        },
        async get(accountId, machineId, now = Date.now()) {
            const redis = redisProvider();
            if (!redis) return memoryRegistry.get(accountId, machineId, now);
            const key = `${REDIS_PREFIX}${machineId}`;
            const lease = parseStoredLease(await redis.get(key));
            if (!lease) return null;
            if (lease.accountId !== accountId || now - lease.updatedAt > ttlMs) {
                if (now - lease.updatedAt > ttlMs) await redis.del(key);
                return null;
            }
            return lease;
        },
    };
}

export const relayRegistry = createRelayRegistryStore(getCoordinationRedis);
