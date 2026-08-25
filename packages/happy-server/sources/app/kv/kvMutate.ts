import { inTx, afterTx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { eventRouter, buildKVBatchUpdateUpdate } from "@/app/events/eventRouter";
import * as privacyKit from "privacy-kit";
import { decodePrismaBytes } from '@/storage/prismaBytes';
import {
    assertAccountResourceQuota,
    configuredResourceLimit,
    enforceAccountWriteRate,
    lockAccountResources,
} from '@/app/api/resourceLimits';
import { base64BytesSchema, utf8StringSchema } from '@/app/api/resourceSchemas';
import { z } from 'zod';

export const KV_KEY_MAX_BYTES = 512;
export const KV_VALUE_MAX_BYTES = 256 * 1024;
export const kvKeySchema = utf8StringSchema({ minBytes: 1, maxBytes: KV_KEY_MAX_BYTES });
export const kvValueSchema = base64BytesSchema(KV_VALUE_MAX_BYTES);
export const kvMutationSchema = z.object({
    key: kvKeySchema,
    value: kvValueSchema.nullable(),
    version: z.number().int().min(-1),
});
export const kvMutationsBodySchema = z.object({
    mutations: z.array(kvMutationSchema).min(1).max(100),
}).superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.mutations.forEach((mutation, index) => {
        if (seen.has(mutation.key)) {
            ctx.addIssue({
                code: 'custom',
                path: ['mutations', index, 'key'],
                message: 'Duplicate keys are not allowed in one mutation batch',
            });
        }
        seen.add(mutation.key);
    });
});

export interface KVMutation {
    key: string;
    value: string | null; // null = delete (sets value to null but keeps record)
    version: number; // Always required, use -1 for new keys
}

export interface KVMutateResult {
    success: boolean;
    results?: Array<{
        key: string;
        version: number;
    }>;
    errors?: Array<{
        key: string;
        error: 'version-mismatch';
        version: number;
        value: string | null;  // Current value (null if deleted)
    }>;
}

/**
 * Atomically mutate multiple key-value pairs.
 * All mutations succeed or all fail.
 * Version is always required for all operations (use -1 for new keys).
 * Delete operations set value to null but keep the record with incremented version.
 * Sends a single bundled update notification for all changes.
 */
export async function kvMutate(
    ctx: { uid: string },
    mutations: KVMutation[]
): Promise<KVMutateResult> {
    const parsedMutations = kvMutationsBodySchema.parse({ mutations }).mutations;
    await enforceAccountWriteRate({
        accountId: ctx.uid,
        resource: 'kv',
        units: parsedMutations.length,
        envName: 'MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 240,
    });
    return await inTx(async (tx) => {
        await lockAccountResources(tx, ctx.uid);
        const errors: KVMutateResult['errors'] = [];
        const existingByKey = new Map<string, Awaited<ReturnType<typeof tx.userKVStore.findUnique>>>();

        // Pre-validate all mutations
        for (const mutation of parsedMutations) {
            const existing = await tx.userKVStore.findUnique({
                where: {
                    accountId_key: {
                        accountId: ctx.uid,
                        key: mutation.key
                    }
                }
            });
            existingByKey.set(mutation.key, existing);

            const currentVersion = existing?.version ?? -1;

            // Version check is always required
            if (currentVersion !== mutation.version) {
                errors.push({
                    key: mutation.key,
                    error: 'version-mismatch',
                    version: currentVersion,
                    value: existing?.value ? privacyKit.encodeBase64(existing.value) : null
                });
            }
        }

        // If any errors, return all errors and abort
        if (errors.length > 0) {
            return { success: false, errors };
        }

        const planned = parsedMutations.map((mutation) => ({
            mutation,
            existing: existingByKey.get(mutation.key) ?? null,
            value: mutation.value === null ? null : decodePrismaBytes(mutation.value),
        }));
        const totals = await tx.$queryRawUnsafe<Array<{ count: bigint; bytes: bigint }>>(
            `SELECT COUNT(*)::bigint AS "count",
                    COALESCE(SUM(octet_length("key") + COALESCE(octet_length("value"), 0)), 0)::bigint AS "bytes"
             FROM "UserKVStore"
             WHERE "accountId" = $1`,
            ctx.uid,
        );
        const delta = planned.reduce((sum, item) => {
            const nextValueBytes = item.value?.byteLength ?? 0;
            if (!item.existing) {
                sum.count += 1;
                sum.bytes += Buffer.byteLength(item.mutation.key, 'utf8') + nextValueBytes;
            } else {
                sum.bytes += nextValueBytes - (item.existing.value?.byteLength ?? 0);
            }
            return sum;
        }, { count: 0, bytes: 0 });
        assertAccountResourceQuota({
            resource: 'kv',
            current: {
                count: Number(totals[0]?.count ?? 0),
                bytes: Number(totals[0]?.bytes ?? 0),
            },
            delta,
            limits: {
                count: configuredResourceLimit('MAX_KV_ENTRIES_PER_ACCOUNT', 5_000),
                bytes: configuredResourceLimit('MAX_KV_BYTES_PER_ACCOUNT', 32 * 1024 * 1024),
            },
        });

        // Apply all mutations and collect results
        const results: Array<{ key: string; version: number }> = [];
        const changes: Array<{ key: string; value: string | null; version: number }> = [];

        for (const { mutation, value } of planned) {
            if (mutation.version === -1) {
                // Create new entry (must not exist)
                const result = await tx.userKVStore.create({
                    data: {
                        accountId: ctx.uid,
                        key: mutation.key,
                        value,
                        version: 0
                    }
                });

                results.push({
                    key: mutation.key,
                    version: result.version
                });

                changes.push({
                    key: mutation.key,
                    value: mutation.value,
                    version: result.version
                });
            } else {
                // Update existing entry (including "delete" which sets value to null)
                const newVersion = mutation.version + 1;

                const result = await tx.userKVStore.update({
                    where: {
                        accountId_key: {
                            accountId: ctx.uid,
                            key: mutation.key
                        }
                    },
                    data: {
                        value,
                        version: newVersion
                    }
                });

                results.push({
                    key: mutation.key,
                    version: result.version
                });

                changes.push({
                    key: mutation.key,
                    value: mutation.value,
                    version: result.version
                });
            }
        }

        // Send single bundled notification for all changes
        afterTx(tx, async () => {
            const updateSeq = await allocateUserSeq(ctx.uid);
            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: buildKVBatchUpdateUpdate(changes, updateSeq, randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return { success: true, results };
    });
}
