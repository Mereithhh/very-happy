/**
 * B-627: relay-to-relay account migration.
 *
 * Source relay (MIGRATION_TARGET_URL set):
 *   GET  /v1/migration          → { target: { url, name } | null }   banner decision
 *   POST /v1/migration/handoff  → { url }                            signed one-way ticket to the new relay
 *
 * Destination relay (MIGRATION_HANDOFF_SECRET set):
 *   POST /v1/auth/migrate/complete { handoff } → web: { kind:'web', token, secret, expiresAt }
 *                                               daemon: { kind:'daemon', token }
 *
 * The database was copied beforehand (docs/deployment.md), so account ids are
 * the same on both sides; the handoff only proves the bearer owned the account
 * on the old relay. SSO users go through /v1/auth/oidc/start with the handoff
 * instead, so the claim and the SSO link happen in one step.
 */
import { z } from 'zod';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { log } from '@/utils/log';
import { auditLogin } from '@/app/audit/requestAudit';
import { clientRateLimitKey } from '@/app/api/clientIp';
import { rateLimitRetryAfter, tooManyRequests, tooManyRequestsSchema } from '@/app/auth/authRateLimitResponse';
import { hashPairingValue } from '@/app/auth/pairingSecurity';
import { loadAccountSecret } from '@/app/auth/accountSecrets';
import { issueMigrationHandoff, verifyMigrationHandoff } from '@/app/migration/handoff';
import { consumeMigrationHandoffNonce } from '@/app/migration/handoffUse';
import { resolveMigrationHandoffSecret, resolveMigrationSourceConfig } from '@/app/migration/migrationConfig';
import { isMigrationTargeted } from '@/app/migration/targeting';

export function migrationLoginUrl(targetWebappUrl: string, handoff: string): string {
    const url = new URL(`${targetWebappUrl}/login/migrate`);
    url.searchParams.set('handoff', handoff);
    return url.toString();
}

export function migrateCompleteRateBucket(ip: string): { key: string; max: number; windowMs: number } {
    return { key: `migrate-complete:ip:${hashPairingValue(ip).slice(0, 32)}`, max: 30, windowMs: 60_000 };
}

export function migrationRoutes(app: Fastify) {
    const source = resolveMigrationSourceConfig();
    const secret = resolveMigrationHandoffSecret();

    if (source && secret) {
        app.get('/v1/migration', {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: z.object({ target: z.object({ url: z.string(), name: z.string() }).nullable() }),
                },
            },
        }, async (request, reply) => {
            reply.header('cache-control', 'no-store');
            const targeted = await isMigrationTargeted(source, request.userId);
            return reply.send({ target: targeted ? { url: source.targetWebappUrl, name: source.targetName } : null });
        });

        app.post('/v1/migration/handoff', {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: z.object({ url: z.string() }),
                    403: z.object({ error: z.literal('not_targeted') }),
                },
            },
        }, async (request, reply) => {
            reply.header('cache-control', 'no-store');
            if (!(await isMigrationTargeted(source, request.userId))) return reply.code(403).send({ error: 'not_targeted' as const });
            const handoff = issueMigrationHandoff(secret, { kind: 'web', accountId: request.userId });
            log({ module: 'migration', accountId: request.userId }, 'Issued web migration handoff');
            return reply.send({ url: migrationLoginUrl(source.targetWebappUrl, handoff) });
        });
    }

    if (secret) {
        app.post('/v1/auth/migrate/complete', {
            schema: {
                body: z.object({ handoff: z.string().min(16).max(4096) }).strict(),
                response: {
                    200: z.union([
                        z.object({ kind: z.literal('web'), token: z.string(), secret: z.string(), expiresAt: z.string() }),
                        z.object({ kind: z.literal('daemon'), token: z.string() }),
                    ]),
                    401: z.object({ error: z.enum(['invalid_handoff', 'account_missing']) }),
                    429: tooManyRequestsSchema,
                },
            },
        }, async (request, reply) => {
            reply.header('cache-control', 'no-store');
            const bucket = migrateCompleteRateBucket(clientRateLimitKey(request));
            const retryAfter = await rateLimitRetryAfter([bucket]);
            if (retryAfter !== null) return reply.code(429).send(tooManyRequests(reply, retryAfter));
            const payload = verifyMigrationHandoff(secret, request.body.handoff);
            if (!payload) return reply.code(401).send({ error: 'invalid_handoff' as const });

            type Refusal = { ok: false; error: 'invalid_handoff' | 'account_missing' };
            type Grant = { ok: true; value: { kind: 'web'; token: string; secret: string; expiresAt: string } | { kind: 'daemon'; token: string } };
            const result = await db.$transaction(async (tx): Promise<Refusal | Grant> => {
                if (!(await consumeMigrationHandoffNonce(tx, payload.nonce, payload.exp))) return { ok: false, error: 'invalid_handoff' };
                const account = await tx.account.findUnique({ where: { id: payload.accountId }, select: { id: true } });
                if (!account) return { ok: false, error: 'account_missing' };
                if (payload.kind === 'daemon') {
                    if (payload.machineId) {
                        const machine = await tx.machine.findUnique({ where: { id: payload.machineId }, select: { accountId: true } });
                        if (machine && machine.accountId !== payload.accountId) return { ok: false, error: 'invalid_handoff' };
                    }
                    return { ok: true, value: { kind: 'daemon', token: await auth.createToken(payload.accountId) } };
                }
                const accountSecret = await loadAccountSecret(tx, payload.accountId);
                if (!accountSecret) return { ok: false, error: 'account_missing' };
                const session = await auth.createLoginToken(payload.accountId, tx, { cache: false });
                return { ok: true, value: { kind: 'web', token: session.token, secret: accountSecret, expiresAt: session.expiresAt.toISOString() } };
            });
            if (!result.ok) {
                log({ module: 'migration', level: 'warn', code: result.error, kind: payload.kind }, 'Migration handoff refused');
                return reply.code(401).send({ error: result.error });
            }
            auditLogin(request, payload.accountId, payload.kind === 'web' ? 'migration' : 'migration-daemon');
            log({ module: 'migration', accountId: payload.accountId, kind: payload.kind }, 'Migration handoff accepted');
            return reply.send(result.value);
        });
    }
}
