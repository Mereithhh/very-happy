import type { Prisma } from '@prisma/client';

export function configuredResourceLimit(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Serialize resource reservations for one account across processes/replicas. */
export async function lockAccountResources(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
        accountId,
    );
    if (!rows[0]) throw new Error('Account not found');
}

export function withinMessageQuota(
    current: { count: number; bytes: number },
    incomingBytes: number,
    limits: { messages: number; bytes: number },
): boolean {
    return (limits.messages === 0 || current.count < limits.messages) &&
        (limits.bytes === 0 || current.bytes + incomingBytes <= limits.bytes);
}

export function withinByteQuota(currentBytes: number, incomingBytes: number, limitBytes: number): boolean {
    return limitBytes === 0 || currentBytes + incomingBytes <= limitBytes;
}
