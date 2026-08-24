import { eventRouter, buildUpdateAccountUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { getPublicUrl } from "@/storage/files";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { AccountProfile } from "@/types";
import {
    ACCOUNT_SETTINGS_MAX_BYTES,
    accountSettingsUpdateSchema,
    enforceAccountSettingsWriteRate,
} from '@/app/account/accountSettingsLimits';
import { isAccountResourceLimitError } from '@/app/api/resourceLimits';
import { inTx } from '@/storage/inTx';
import {
    isE2eeDataGuardError,
    lockAndValidateE2eeWriter,
    validateE2eeSettingsValue,
    writerAuthFromRequest,
    type AccountCryptoState,
} from '@/app/auth/e2eeDataGuard';

export function accountRoutes(app: Fastify) {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
                githubUser: true
            }
        });
        const connectedVendors = new Set((await db.serviceAccountToken.findMany({ where: { accountId: userId } })).map(t => t.vendor));
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            github: user.githubUser ? user.githubUser.profile : null,
            connectedServices: Array.from(connectedVendors)
        });
    });

    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    settings: z.string().nullable(),
                    settingsVersion: z.number()
                }),
                409: z.object({ error: z.literal('e2ee_data_invalid') }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    id: true,
                    settings: true,
                    settingsVersion: true,
                    cryptoMode: true,
                    cryptoEpoch: true,
                    cryptoWriteState: true,
                    e2eeOrigin: true,
                }
            });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }
            if (user.cryptoMode === 'e2ee-v1' && user.settings !== null) {
                validateE2eeSettingsValue(
                    user.settings,
                    user as AccountCryptoState,
                    ACCOUNT_SETTINGS_MAX_BYTES,
                    'e2ee_data_invalid',
                    'read-existing',
                );
            }

            return reply.send({
                settings: user.settings,
                settingsVersion: user.settingsVersion
            });
        } catch (error) {
            if (isE2eeDataGuardError(error)) {
                return reply.code(409).send({ error: 'e2ee_data_invalid' });
            }
            return reply.code(500).send({ error: 'Failed to get account settings' });
        }
    });

    // Update Account Settings API
    app.post('/v1/account/settings', {
        schema: {
            body: accountSettingsUpdateSchema,
            response: {
                200: z.union([z.object({
                    success: z.literal(true),
                    version: z.number()
                }), z.object({
                    success: z.literal(false),
                    error: z.literal('version-mismatch'),
                    currentVersion: z.number(),
                    currentSettings: z.string().nullable()
                })]),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                }),
                429: z.object({
                    success: z.literal(false),
                    error: z.literal('account_settings_rate_quota_exceeded')
                }),
                // Fastify body validation also uses 400; keep its standard
                // error shape while handler-originated E2EE errors stay stable.
                400: z.any(),
                409: z.object({ error: z.enum(['e2ee_rekey_required', 'e2ee_data_invalid']) }),
                426: z.object({ error: z.literal('e2ee_client_required') }),
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            await enforceAccountSettingsWriteRate(userId);
            const outcome = await inTx(async (tx) => {
                const account = await lockAndValidateE2eeWriter(tx, userId, writerAuthFromRequest(request));
                if (account.cryptoMode === 'e2ee-v1' && settings !== null) {
                    validateE2eeSettingsValue(settings, account, ACCOUNT_SETTINGS_MAX_BYTES);
                }

                const currentUser = await tx.account.findUnique({
                    where: { id: userId },
                    select: { settings: true, settingsVersion: true },
                });
                if (!currentUser) return { kind: 'missing' as const };
                if (account.cryptoMode === 'e2ee-v1' && currentUser.settings !== null) {
                    validateE2eeSettingsValue(
                        currentUser.settings,
                        account,
                        ACCOUNT_SETTINGS_MAX_BYTES,
                        'e2ee_data_invalid',
                        'read-existing',
                    );
                }
                if (currentUser.settingsVersion !== expectedVersion) {
                    return {
                        kind: 'mismatch' as const,
                        currentVersion: currentUser.settingsVersion,
                        currentSettings: currentUser.settings,
                    };
                }

                const { count } = await tx.account.updateMany({
                    where: { id: userId, settingsVersion: expectedVersion },
                    data: {
                        settings,
                        settingsVersion: expectedVersion + 1,
                        updatedAt: new Date(),
                    },
                });
                if (count !== 1) throw new Error('Account settings CAS changed while account row was locked');
                return { kind: 'updated' as const };
            });

            if (outcome.kind === 'missing') {
                return reply.code(500).send({ success: false, error: 'Failed to update account settings' });
            }
            if (outcome.kind === 'mismatch') {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: outcome.currentVersion,
                    currentSettings: outcome.currentSettings,
                });
            }

            // Generate update for connected clients
            const updSeq = await allocateUserSeq(userId);
            const settingsUpdate = {
                value: settings,
                version: expectedVersion + 1
            };

            // Send account update to user-scoped connections only
            const updatePayload = buildUpdateAccountUpdate(userId, { settings: settingsUpdate }, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                version: expectedVersion + 1
            });
        } catch (error) {
            if (isE2eeDataGuardError(error)) {
                return reply.code(error.statusCode).send({ error: error.code as any });
            }
            if (isAccountResourceLimitError(error) && error.code === 'account_settings_rate_quota_exceeded') {
                return reply.code(429).send({ success: false, error: 'account_settings_rate_quota_exceeded' });
            }
            log({ module: 'api', level: 'error', error }, 'Failed to update account settings');
            return reply.code(500).send({
                success: false,
                error: 'Failed to update account settings'
            });
        }
    });

    app.post('/v1/usage/query', {
        schema: {
            body: z.object({
                sessionId: z.string().nullish(),
                startTime: z.number().int().positive().nullish(),
                endTime: z.number().int().positive().nullish(),
                groupBy: z.enum(['hour', 'day']).nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            // Build query conditions
            const where: {
                accountId: string;
                sessionId?: string | null;
                createdAt?: {
                    gte?: Date;
                    lte?: Date;
                };
            } = {
                accountId: userId
            };

            if (sessionId) {
                // Verify session belongs to user
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId
                    }
                });
                if (!session) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
                where.sessionId = sessionId;
            }

            if (startTime || endTime) {
                where.createdAt = {};
                if (startTime) {
                    where.createdAt.gte = new Date(startTime * 1000);
                }
                if (endTime) {
                    where.createdAt.lte = new Date(endTime * 1000);
                }
            }

            // Fetch usage reports
            const reports = await db.usageReport.findMany({
                where,
                orderBy: {
                    createdAt: 'desc'
                }
            });

            // Aggregate data by time period
            const aggregated = new Map<string, {
                tokens: Record<string, number>;
                cost: Record<string, number>;
                count: number;
                timestamp: number;
            }>();

            for (const report of reports) {
                const data = report.data as PrismaJson.UsageReportData;
                const date = new Date(report.createdAt);

                // Calculate timestamp based on groupBy
                let timestamp: number;
                if (actualGroupBy === 'hour') {
                    // Round down to hour
                    const hourDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
                    timestamp = Math.floor(hourDate.getTime() / 1000);
                } else {
                    // Round down to day
                    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    timestamp = Math.floor(dayDate.getTime() / 1000);
                }

                const key = timestamp.toString();

                if (!aggregated.has(key)) {
                    aggregated.set(key, {
                        tokens: {},
                        cost: {},
                        count: 0,
                        timestamp
                    });
                }

                const agg = aggregated.get(key)!;
                agg.count++;

                // Aggregate tokens
                for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                    if (typeof tokenValue === 'number') {
                        agg.tokens[tokenKey] = (agg.tokens[tokenKey] || 0) + tokenValue;
                    }
                }

                // Aggregate costs
                for (const [costKey, costValue] of Object.entries(data.cost)) {
                    if (typeof costValue === 'number') {
                        agg.cost[costKey] = (agg.cost[costKey] || 0) + costValue;
                    }
                }
            }

            // Convert to array and sort by timestamp
            const result = Array.from(aggregated.values())
                .map(data => ({
                    timestamp: data.timestamp,
                    tokens: data.tokens,
                    cost: data.cost,
                    reportCount: data.count
                }))
                .sort((a, b) => a.timestamp - b.timestamp);

            return reply.send({
                usage: result,
                groupBy: actualGroupBy,
                totalReports: reports.length
            });
        } catch (error) {
            log({ module: 'api', level: 'error', error }, 'Failed to query usage reports');
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });
}
