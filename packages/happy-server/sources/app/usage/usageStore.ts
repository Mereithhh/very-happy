import type { UsageReport } from '@prisma/client';
import {
    assertAccountResourceQuota,
    configuredResourceLimit,
    enforceAccountWriteRate,
    lockAccountResources,
} from '@/app/api/resourceLimits';
import { utf8StringSchema } from '@/app/api/resourceSchemas';
import { inTx } from '@/storage/inTx';
import { z } from 'zod';

export const USAGE_KEY_MAX_BYTES = 256;
export const USAGE_SESSION_ID_MAX_BYTES = 256;
export const USAGE_DIMENSION_KEY_MAX_BYTES = 64;
export const USAGE_DIMENSIONS_MAX = 32;
export const USAGE_PAYLOAD_MAX_BYTES = 16 * 1024;

const usageNumberSchema = z.number().finite().nonnegative();
const usageDimensionsSchema = z.object({ total: usageNumberSchema }).catchall(usageNumberSchema).superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > USAGE_DIMENSIONS_MAX) {
        ctx.addIssue({ code: 'custom', message: `At most ${USAGE_DIMENSIONS_MAX} dimensions are allowed` });
    }
    for (const key of keys) {
        const keyResult = utf8StringSchema({ minBytes: 1, maxBytes: USAGE_DIMENSION_KEY_MAX_BYTES }).safeParse(key);
        if (!keyResult.success) {
            ctx.addIssue({ code: 'custom', path: [key], message: 'Usage dimension key is too long' });
        }
    }
});

export const usageReportSchema = z.object({
    key: utf8StringSchema({ minBytes: 1, maxBytes: USAGE_KEY_MAX_BYTES }),
    sessionId: utf8StringSchema({ minBytes: 1, maxBytes: USAGE_SESSION_ID_MAX_BYTES }).nullish(),
    tokens: usageDimensionsSchema,
    cost: usageDimensionsSchema,
}).superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify({ tokens: value.tokens, cost: value.cost }), 'utf8') > USAGE_PAYLOAD_MAX_BYTES) {
        ctx.addIssue({ code: 'custom', message: `Usage payload must contain at most ${USAGE_PAYLOAD_MAX_BYTES} bytes` });
    }
});

export type SaveUsageReportResult =
    | { kind: 'session-not-found' }
    | { kind: 'success'; report: UsageReport };

export async function saveUsageReport(
    accountId: string,
    input: z.infer<typeof usageReportSchema>,
): Promise<SaveUsageReportResult> {
    const parsed = usageReportSchema.parse(input);
    await enforceAccountWriteRate({
        accountId,
        resource: 'usage_report',
        envName: 'MAX_USAGE_REPORT_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 600,
    });
    const sessionId = parsed.sessionId ?? null;
    const data: PrismaJson.UsageReportData = { tokens: parsed.tokens, cost: parsed.cost };

    return inTx(async (tx) => {
        await lockAccountResources(tx, accountId);
        if (sessionId) {
            const session = await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } });
            if (!session) return { kind: 'session-not-found' as const };
        }

        // Do not rely on PostgreSQL NULL uniqueness: NULL sessionId values are
        // not equal for a compound unique constraint. The account lock makes
        // this explicit find/update-or-create path atomic.
        const existing = await tx.usageReport.findFirst({
            where: { accountId, sessionId, key: parsed.key },
        });
        if (existing) {
            const report = await tx.usageReport.update({
                where: { id: existing.id },
                data: { data, updatedAt: new Date() },
            });
            return { kind: 'success' as const, report };
        }

        const count = await tx.usageReport.count({ where: { accountId } });
        assertAccountResourceQuota({
            resource: 'usage_report',
            current: { count, bytes: 0 },
            delta: { count: 1, bytes: 0 },
            limits: {
                count: configuredResourceLimit('MAX_USAGE_REPORTS_PER_ACCOUNT', 5_000),
                bytes: 0,
            },
        });
        const report = await tx.usageReport.create({
            data: { accountId, sessionId, key: parsed.key, data },
        });
        return { kind: 'success' as const, report };
    });
}
