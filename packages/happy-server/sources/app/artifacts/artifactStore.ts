import type { Artifact, Prisma } from '@prisma/client';
import {
    assertAccountResourceQuota,
    configuredResourceLimit,
    enforceAccountWriteRate,
    lockAccountResources,
} from '@/app/api/resourceLimits';
import { base64BytesSchema } from '@/app/api/resourceSchemas';
import { inTx } from '@/storage/inTx';
import { decodePrismaBytes } from '@/storage/prismaBytes';
import { z } from 'zod';

export const ARTIFACT_HEADER_MAX_BYTES = 256 * 1024;
export const ARTIFACT_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_DATA_KEY_MAX_BYTES = 4 * 1024;

export const artifactIdSchema = z.string().uuid();
export const artifactCreateSchema = z.object({
    id: artifactIdSchema,
    header: base64BytesSchema(ARTIFACT_HEADER_MAX_BYTES),
    body: base64BytesSchema(ARTIFACT_BODY_MAX_BYTES),
    dataEncryptionKey: base64BytesSchema(ARTIFACT_DATA_KEY_MAX_BYTES),
});
export const artifactUpdateSchema = z.object({
    header: base64BytesSchema(ARTIFACT_HEADER_MAX_BYTES).optional(),
    expectedHeaderVersion: z.number().int().min(0).optional(),
    body: base64BytesSchema(ARTIFACT_BODY_MAX_BYTES).optional(),
    expectedBodyVersion: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
    if (value.header === undefined && value.body === undefined) {
        ctx.addIssue({ code: 'custom', message: 'At least one artifact update is required' });
    }
    if ((value.header === undefined) !== (value.expectedHeaderVersion === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'header and expectedHeaderVersion must be supplied together' });
    }
    if ((value.body === undefined) !== (value.expectedBodyVersion === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'body and expectedBodyVersion must be supplied together' });
    }
});

async function artifactUsage(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRawUnsafe<Array<{ count: bigint; bytes: bigint }>>(
        `SELECT COUNT(*)::bigint AS "count",
                COALESCE(SUM(
                    octet_length("header") + octet_length("body") + octet_length("dataEncryptionKey")
                ), 0)::bigint AS "bytes"
         FROM "Artifact"
         WHERE "accountId" = $1`,
        accountId,
    );
    return {
        count: Number(rows[0]?.count ?? 0),
        bytes: Number(rows[0]?.bytes ?? 0),
    };
}

function assertArtifactQuota(
    current: { count: number; bytes: number },
    delta: { count: number; bytes: number },
) {
    assertAccountResourceQuota({
        resource: 'artifact',
        current,
        delta,
        limits: {
            count: configuredResourceLimit('MAX_ARTIFACTS_PER_ACCOUNT', 1_000),
            bytes: configuredResourceLimit('MAX_ARTIFACT_BYTES_PER_ACCOUNT', 256 * 1024 * 1024),
        },
    });
}

export type ArtifactCreateResult =
    | { kind: 'success'; artifact: Artifact; created: boolean }
    | { kind: 'foreign-id-conflict' };

export async function createArtifactWithQuota(
    accountId: string,
    input: z.infer<typeof artifactCreateSchema>,
): Promise<ArtifactCreateResult> {
    const parsed = artifactCreateSchema.parse(input);
    await enforceAccountWriteRate({
        accountId,
        resource: 'artifact',
        envName: 'MAX_ARTIFACT_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 120,
    });
    const header = decodePrismaBytes(parsed.header);
    const body = decodePrismaBytes(parsed.body);
    const dataEncryptionKey = decodePrismaBytes(parsed.dataEncryptionKey);

    return inTx(async (tx) => {
        await lockAccountResources(tx, accountId);
        const existing = await tx.artifact.findUnique({ where: { id: parsed.id } });
        if (existing) {
            return existing.accountId === accountId
                ? { kind: 'success' as const, artifact: existing, created: false }
                : { kind: 'foreign-id-conflict' as const };
        }

        assertArtifactQuota(await artifactUsage(tx, accountId), {
            count: 1,
            bytes: header.byteLength + body.byteLength + dataEncryptionKey.byteLength,
        });
        const artifact = await tx.artifact.create({
            data: {
                id: parsed.id,
                accountId,
                header,
                headerVersion: 1,
                body,
                bodyVersion: 1,
                dataEncryptionKey,
                seq: 0,
            },
        });
        return { kind: 'success' as const, artifact, created: true };
    });
}

export type ArtifactUpdateResult =
    | { kind: 'not-found' }
    | { kind: 'version-mismatch'; artifact: Artifact; headerMismatch: boolean; bodyMismatch: boolean }
    | {
        kind: 'success';
        headerUpdate?: { value: string; version: number };
        bodyUpdate?: { value: string; version: number };
    };

export async function updateArtifactWithQuota(
    accountId: string,
    artifactId: string,
    input: z.infer<typeof artifactUpdateSchema>,
): Promise<ArtifactUpdateResult> {
    const parsed = artifactUpdateSchema.parse(input);
    await enforceAccountWriteRate({
        accountId,
        resource: 'artifact',
        envName: 'MAX_ARTIFACT_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 120,
    });
    const nextHeader = parsed.header === undefined ? undefined : decodePrismaBytes(parsed.header);
    const nextBody = parsed.body === undefined ? undefined : decodePrismaBytes(parsed.body);

    return inTx(async (tx) => {
        await lockAccountResources(tx, accountId);
        const current = await tx.artifact.findFirst({ where: { id: artifactId, accountId } });
        if (!current) return { kind: 'not-found' as const };

        const headerMismatch = parsed.header !== undefined && current.headerVersion !== parsed.expectedHeaderVersion;
        const bodyMismatch = parsed.body !== undefined && current.bodyVersion !== parsed.expectedBodyVersion;
        if (headerMismatch || bodyMismatch) {
            return { kind: 'version-mismatch' as const, artifact: current, headerMismatch, bodyMismatch };
        }

        const byteDelta = (nextHeader?.byteLength ?? current.header.byteLength) - current.header.byteLength
            + (nextBody?.byteLength ?? current.body.byteLength) - current.body.byteLength;
        assertArtifactQuota(await artifactUsage(tx, accountId), { count: 0, bytes: byteDelta });

        const headerUpdate = parsed.header === undefined ? undefined : {
            value: parsed.header,
            version: parsed.expectedHeaderVersion! + 1,
        };
        const bodyUpdate = parsed.body === undefined ? undefined : {
            value: parsed.body,
            version: parsed.expectedBodyVersion! + 1,
        };
        await tx.artifact.update({
            where: { id: artifactId },
            data: {
                ...(nextHeader && { header: nextHeader, headerVersion: headerUpdate!.version }),
                ...(nextBody && { body: nextBody, bodyVersion: bodyUpdate!.version }),
                seq: current.seq + 1,
                updatedAt: new Date(),
            },
        });
        return { kind: 'success' as const, headerUpdate, bodyUpdate };
    });
}
