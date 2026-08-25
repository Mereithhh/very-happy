import type { ServerRelayProbe } from './relaySchemas';

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

export const relayRegistry = new RelayRegistry(75_000);
