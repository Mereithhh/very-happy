import type { AccessKey, Prisma } from '@prisma/client';
import {
    assertAccountResourceQuota,
    configuredResourceLimit,
    enforceAccountWriteRate,
    lockAccountResources,
} from '@/app/api/resourceLimits';
import { base64BytesSchema, utf8StringSchema } from '@/app/api/resourceSchemas';
import { inTx } from '@/storage/inTx';
import { z } from 'zod';

export const ACCESS_KEY_DATA_MAX_DECODED_BYTES = 4 * 1024;
export const ACCESS_KEY_ID_MAX_BYTES = 256;

export const accessKeyIdSchema = utf8StringSchema({ minBytes: 1, maxBytes: ACCESS_KEY_ID_MAX_BYTES });
export const accessKeyDataSchema = base64BytesSchema(ACCESS_KEY_DATA_MAX_DECODED_BYTES);
export const accessKeyCreateSchema = z.object({ data: accessKeyDataSchema }).strict();
export const accessKeyUpdateSchema = z.object({
    data: accessKeyDataSchema,
    expectedVersion: z.number().int().min(0),
}).strict();

async function accessKeyUsage(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRawUnsafe<Array<{ count: bigint; bytes: bigint }>>(
        `SELECT COUNT(*)::bigint AS "count",
                COALESCE(SUM(octet_length("data")), 0)::bigint AS "bytes"
         FROM "AccessKey"
         WHERE "accountId" = $1`,
        accountId,
    );
    return {
        count: Number(rows[0]?.count ?? 0),
        bytes: Number(rows[0]?.bytes ?? 0),
    };
}

function assertAccessKeyQuota(
    current: { count: number; bytes: number },
    delta: { count: number; bytes: number },
) {
    assertAccountResourceQuota({
        resource: 'access_key',
        current,
        delta,
        limits: {
            count: configuredResourceLimit('MAX_ACCESS_KEYS_PER_ACCOUNT', 2_000),
            // This measures the encoded UTF-8 data stored by Prisma/Postgres.
            bytes: configuredResourceLimit('MAX_ACCESS_KEY_BYTES_PER_ACCOUNT', 8 * 1024 * 1024),
        },
    });
}

async function enforceAccessKeyWriteRate(accountId: string): Promise<void> {
    await enforceAccountWriteRate({
        accountId,
        resource: 'access_key',
        envName: 'MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 120,
    });
}

export type CreateAccessKeyResult =
    | { kind: 'owner-not-found' }
    | { kind: 'conflict'; accessKey: AccessKey }
    | { kind: 'success'; accessKey: AccessKey; created: boolean };

/**
 * Atomically validates ownership, applies account quotas, and creates one
 * encrypted session/machine key. Exact retries are idempotent; a retry with a
 * different envelope remains a conflict rather than an implicit overwrite.
 */
export async function createAccessKeyWithQuota(options: {
    accountId: string;
    sessionId: string;
    machineId: string;
    data: string;
}): Promise<CreateAccessKeyResult> {
    const sessionId = accessKeyIdSchema.parse(options.sessionId);
    const machineId = accessKeyIdSchema.parse(options.machineId);
    const { data } = accessKeyCreateSchema.parse({ data: options.data });
    await enforceAccessKeyWriteRate(options.accountId);

    return inTx(async (tx) => {
        await lockAccountResources(tx, options.accountId);
        const [session, machine] = await Promise.all([
            tx.session.findFirst({ where: { id: sessionId, accountId: options.accountId }, select: { id: true } }),
            tx.machine.findFirst({ where: { id: machineId, accountId: options.accountId }, select: { id: true } }),
        ]);
        if (!session || !machine) return { kind: 'owner-not-found' as const };

        const existing = await tx.accessKey.findUnique({
            where: { accountId_machineId_sessionId: { accountId: options.accountId, machineId, sessionId } },
        });
        if (existing) {
            return existing.data === data
                ? { kind: 'success' as const, accessKey: existing, created: false }
                : { kind: 'conflict' as const, accessKey: existing };
        }

        assertAccessKeyQuota(await accessKeyUsage(tx, options.accountId), {
            count: 1,
            bytes: Buffer.byteLength(data, 'utf8'),
        });
        const accessKey = await tx.accessKey.create({
            data: {
                accountId: options.accountId,
                machineId,
                sessionId,
                data,
                dataVersion: 1,
            },
        });
        return { kind: 'success' as const, accessKey, created: true };
    });
}

export type UpdateAccessKeyResult =
    | { kind: 'not-found' }
    | { kind: 'version-mismatch'; accessKey: AccessKey }
    | { kind: 'success'; accessKey: AccessKey };

export async function updateAccessKeyWithQuota(options: {
    accountId: string;
    sessionId: string;
    machineId: string;
    data: string;
    expectedVersion: number;
}): Promise<UpdateAccessKeyResult> {
    const sessionId = accessKeyIdSchema.parse(options.sessionId);
    const machineId = accessKeyIdSchema.parse(options.machineId);
    const parsed = accessKeyUpdateSchema.parse({ data: options.data, expectedVersion: options.expectedVersion });
    await enforceAccessKeyWriteRate(options.accountId);

    return inTx(async (tx) => {
        await lockAccountResources(tx, options.accountId);
        const current = await tx.accessKey.findUnique({
            where: { accountId_machineId_sessionId: { accountId: options.accountId, machineId, sessionId } },
        });
        if (!current) return { kind: 'not-found' as const };
        if (current.dataVersion !== parsed.expectedVersion) {
            return { kind: 'version-mismatch' as const, accessKey: current };
        }

        assertAccessKeyQuota(await accessKeyUsage(tx, options.accountId), {
            count: 0,
            bytes: Buffer.byteLength(parsed.data, 'utf8') - Buffer.byteLength(current.data, 'utf8'),
        });
        const accessKey = await tx.accessKey.update({
            where: { id: current.id },
            data: {
                data: parsed.data,
                dataVersion: parsed.expectedVersion + 1,
                updatedAt: new Date(),
            },
        });
        return { kind: 'success' as const, accessKey };
    });
}

