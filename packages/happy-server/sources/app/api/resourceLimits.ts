import type { Prisma } from '@prisma/client';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';

export type AccountResource = 'access_key' | 'account_settings' | 'artifact' | 'attachment' | 'feed' | 'kv' | 'machine_state' | 'message' | 'push_token' | 'relationship' | 'session_state' | 'usage_report';
export type AccountResourceLimitKind = 'bytes' | 'count' | 'rate';

/** Stable, machine-readable failure shared by HTTP and Socket.IO writers. */
export class AccountResourceLimitError extends Error {
    readonly code: string;
    readonly statusCode: 413 | 429;

    constructor(
        readonly resource: AccountResource,
        readonly kind: AccountResourceLimitKind,
    ) {
        const code = `${resource}_${kind}_quota_exceeded`;
        super(code);
        this.name = 'AccountResourceLimitError';
        this.code = code;
        this.statusCode = kind === 'bytes' ? 413 : 429;
    }
}

export function isAccountResourceLimitError(error: unknown): error is AccountResourceLimitError {
    return error instanceof AccountResourceLimitError;
}

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

/**
 * Consume a fixed-window write budget shared by every replica and ingress path.
 * `units` matters for batch APIs: a 100-item request costs 100, not one.
 */
export async function enforceAccountWriteRate(options: {
    accountId: string;
    resource: AccountResource;
    units?: number;
    envName: string;
    fallback: number;
}): Promise<void> {
    const units = options.units ?? 1;
    if (!Number.isSafeInteger(units) || units < 1) {
        throw new Error('Write-rate units must be a positive safe integer');
    }
    const max = configuredResourceLimit(options.envName, options.fallback);
    if (max === 0) return;
    const allowed = await allowAuthRequest(
        `resource-write:${options.resource}:${options.accountId}`,
        { max, windowMs: 60_000, cost: units },
    );
    if (!allowed) throw new AccountResourceLimitError(options.resource, 'rate');
}

export function assertAccountResourceQuota(options: {
    resource: AccountResource;
    current: { count: number; bytes: number };
    delta: { count: number; bytes: number };
    limits: { count: number; bytes: number };
}): void {
    const nextCount = options.current.count + options.delta.count;
    const nextBytes = options.current.bytes + options.delta.bytes;
    if (options.delta.count > 0 && options.limits.count > 0 && nextCount > options.limits.count) {
        throw new AccountResourceLimitError(options.resource, 'count');
    }
    if (options.delta.bytes > 0 && options.limits.bytes > 0 && nextBytes > options.limits.bytes) {
        throw new AccountResourceLimitError(options.resource, 'bytes');
    }
}

/** Caller must keep this reservation and the message inserts in the same transaction. */
export async function reserveAccountMessages(
    tx: Prisma.TransactionClient,
    accountId: string,
    incoming: { count: number; bytes: number },
): Promise<void> {
    await lockAccountResources(tx, accountId);
    const totals = await tx.$queryRawUnsafe<Array<{ count: bigint; bytes: bigint }>>(
        `SELECT COUNT(*)::bigint AS "count",
                COALESCE(SUM(octet_length(sm."content"->>'c')), 0)::bigint AS "bytes"
         FROM "SessionMessage" sm
         JOIN "Session" s ON s."id" = sm."sessionId"
         WHERE s."accountId" = $1`,
        accountId,
    );
    assertAccountResourceQuota({
        resource: 'message',
        current: {
            count: Number(totals[0]?.count ?? 0),
            bytes: Number(totals[0]?.bytes ?? 0),
        },
        delta: incoming,
        limits: {
            count: configuredResourceLimit('MAX_MESSAGES_PER_ACCOUNT', 100_000),
            bytes: configuredResourceLimit('MAX_MESSAGE_BYTES_PER_ACCOUNT', 512 * 1024 * 1024),
        },
    });
}

export function withinByteQuota(currentBytes: number, incomingBytes: number, limitBytes: number): boolean {
    return limitBytes === 0 || currentBytes + incomingBytes <= limitBytes;
}
