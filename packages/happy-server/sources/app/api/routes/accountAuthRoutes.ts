import { z } from 'zod';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import tweetnacl from 'tweetnacl';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { log } from '@/utils/log';
import { loadAccountSecret, upsertAccountSecret } from '@/app/auth/accountSecrets';
import { getSignupStatus, resolveSignupPolicy, SignupPolicyError, withSignupGate } from '@/app/auth/signupPolicy';
import { verifyGoogleIdToken } from '@/app/auth/googleOidc';
import {
    consumeGoogleLoginChallenge,
    GoogleLoginChallengeCapacityError,
    isGoogleOriginAllowed,
    issueGoogleLoginChallenge,
    resolveGoogleLoginConfig,
} from '@/app/auth/googleLoginSecurity';
import { signupRejectionsCounter } from '@/app/monitoring/metrics2';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { decodeFixedBase64, hashPairingValue } from '@/app/auth/pairingSecurity';
import { configuredResourceLimit } from '../resourceLimits';
import {
    assertUsableInteractiveAuth,
    isPasswordLoginEnabled,
    resolveEmailAuthConfig,
} from '@/app/auth/emailAuthConfig';
import {
    consumeEmailLoginChallenge,
    createEmailLoginChallenge,
    deleteEmailLoginChallenge,
    EmailLoginChallengeCapacityError,
    normalizeEmail,
} from '@/app/auth/emailLoginSecurity';
import { EmailDeliveryError, sendLoginCode } from '@/app/auth/emailSender';
import {
    EmailIdentityInUseError,
    getAccountLoginMethods,
    linkVerifiedEmailIdentity,
} from '@/app/auth/emailIdentityLink';
import {
    GoogleIdentityInUseError,
    linkVerifiedGoogleIdentity,
} from '@/app/auth/googleIdentityLink';

/** Username/password + Google identity for the server-trusted Cloud model. */

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, 64) as Buffer;
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
    try {
        const parts = stored.split('$');
        if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
        if (!/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) return false;
        const salt = Buffer.from(parts[1], 'hex');
        const expected = Buffer.from(parts[2], 'hex');
        const derived = await scryptAsync(password, salt, expected.length) as Buffer;
        return expected.length === derived.length && timingSafeEqual(expected, derived);
    } catch {
        return false;
    }
}

async function burnMissingPasswordLookup(password: string): Promise<void> {
    await scryptAsync(password, Buffer.alloc(16), 64);
}

const loginResponse = z.object({
    token: z.string(),
    secret: z.string(),
    expiresAt: z.string().optional(),
});
const newUsernameSchema = z.string().trim().toLowerCase().min(3).max(64);
const loginUsernameSchema = z.string().trim().toLowerCase().min(1).max(64);
const passwordSchema = z.string().min(8).max(256);
const emailSchema = z.string().trim().min(3).max(254).regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/);
const emailCodeSchema = z.string().regex(/^\d{6}$/);

class UsernameTakenError extends Error {}

export function accountPublicKeyFromSecret(secret: string): string | null {
    const seed = decodeFixedBase64(secret, 32);
    if (!seed) return null;
    const keyPair = tweetnacl.sign.keyPair.fromSeed(Uint8Array.from(seed));
    return Buffer.from(keyPair.publicKey).toString('hex');
}

export function passwordLoginRateBuckets(ip: string, username: string): Array<{ key: string; max: number }> {
    const ipKey = hashPairingValue(ip).slice(0, 32);
    const usernameKey = hashPairingValue(username).slice(0, 32);
    return [
        { key: `password-login:ip:${ipKey}`, max: 20 },
        { key: `password-login:user:${usernameKey}`, max: 10 },
        { key: 'password-login:global', max: 200 },
    ];
}

export async function consumeRateBucketsSequentially(
    buckets: ReadonlyArray<{ key: string; max: number; windowMs?: number }>,
    consume: typeof allowAuthRequest = allowAuthRequest,
): Promise<boolean> {
    for (const bucket of buckets) {
        if (!(await consume(bucket.key, { max: bucket.max, windowMs: bucket.windowMs ?? 60_000 }))) return false;
    }
    return true;
}

export function emailCodeRateBuckets(
    ip: string,
    email: string,
    limits: { globalDailySendLimit: number; globalMonthlySendLimit: number },
): Array<{ key: string; max: number; windowMs?: number }> {
    const ipKey = hashPairingValue(ip).slice(0, 32);
    const emailKey = hashPairingValue(email).slice(0, 32);
    return [
        { key: `email-code:ip:${ipKey}:minute`, max: 10 },
        { key: `email-code:ip:${ipKey}:hour`, max: 20, windowMs: 60 * 60_000 },
        { key: `email-code:ip:${ipKey}:day`, max: 50, windowMs: 24 * 60 * 60_000 },
        { key: `email-code:email:${emailKey}:ten-minute`, max: 3, windowMs: 10 * 60_000 },
        { key: `email-code:email:${emailKey}:day`, max: 3, windowMs: 24 * 60 * 60_000 },
        { key: 'email-code:global:hour', max: 60, windowMs: 60 * 60_000 },
        { key: 'email-code:global:day', max: limits.globalDailySendLimit, windowMs: 24 * 60 * 60_000 },
        { key: 'email-code:global:month', max: limits.globalMonthlySendLimit, windowMs: 30 * 24 * 60 * 60_000 },
    ];
}

export function emailVerifyRateBuckets(ip: string, email: string, challengeId: string): Array<{ key: string; max: number; windowMs?: number }> {
    const ipKey = hashPairingValue(ip).slice(0, 32);
    const emailKey = hashPairingValue(email).slice(0, 32);
    const challengeKey = hashPairingValue(challengeId).slice(0, 32);
    return [
        { key: `email-verify:ip:${ipKey}:minute`, max: 30 },
        { key: `email-verify:ip:${ipKey}:day`, max: 100, windowMs: 24 * 60 * 60_000 },
        { key: `email-verify:email:${emailKey}:hour`, max: 6, windowMs: 60 * 60_000 },
        { key: `email-verify:email:${emailKey}:day`, max: 9, windowMs: 24 * 60 * 60_000 },
        { key: `email-verify:challenge:${challengeKey}`, max: 4 },
        { key: 'email-verify:global:hour', max: 300, windowMs: 60 * 60_000 },
    ];
}

export function googleChallengeRateBucket(ip: string): { key: string; max: number; windowMs: number } {
    return {
        key: `google-challenge:ip:${hashPairingValue(ip).slice(0, 32)}`,
        max: 60,
        windowMs: 60_000,
    };
}

export function googleLoginRateBucket(ip: string): { key: string; max: number; windowMs: number } {
    return {
        key: `google-login:ip:${hashPairingValue(ip).slice(0, 32)}`,
        max: 60,
        windowMs: 60_000,
    };
}

export function enabledReplacementIdentityProviders(emailEnabled: boolean, googleEnabled: boolean): Array<'email' | 'google'> {
    return [emailEnabled ? 'email' as const : null, googleEnabled ? 'google' as const : null]
        .filter((provider): provider is 'email' | 'google' => provider !== null);
}

type LoginSessionQuery = Pick<typeof db, '$queryRawUnsafe'>;

export async function hasRecentLoginSessionWithDb(
    client: LoginSessionQuery,
    accountId: string,
    loginSessionId: string | undefined,
    nowMs = Date.now(),
): Promise<boolean> {
    if (!loginSessionId) return false;
    // Production intentionally bind-mounts server sources over a stable image.
    // Keep this compatibility check on raw SQL so adding AccountLoginSession in
    // a migration does not require a regenerated Prisma model delegate before
    // the new source can safely run.
    const sessions = await client.$queryRawUnsafe<Array<{ createdAt: Date }>>(
        `SELECT "createdAt"
         FROM "AccountLoginSession"
         WHERE "id" = $1
           AND "accountId" = $2
           AND "revokedAt" IS NULL
           AND "expiresAt" > $3
         LIMIT 1`,
        loginSessionId,
        accountId,
        new Date(nowMs),
    );
    return !!sessions[0] && sessions[0].createdAt.getTime() >= nowMs - 10 * 60_000;
}

async function hasRecentLoginSession(accountId: string, loginSessionId: string | undefined): Promise<boolean> {
    return hasRecentLoginSessionWithDb(db, accountId, loginSessionId);
}

async function matchesAccountSecret(accountId: string, secret: string): Promise<boolean> {
    const derivedPublicKey = accountPublicKeyFromSecret(secret);
    const account = derivedPublicKey
        ? await db.account.findUnique({ where: { id: accountId }, select: { publicKey: true } })
        : null;
    // Legacy Happy accounts stored this hex key in uppercase while newer
    // account-login paths store lowercase. Hex is case-insensitive; treating
    // the representation as identity would lock valid legacy owners out of
    // refresh and identity linking.
    return !!account && account.publicKey.toLowerCase() === derivedPublicKey;
}

export function accountAuthRoutes(app: Fastify) {
    // Fail startup on a typo that could otherwise accidentally remove the cap.
    resolveSignupPolicy();
    const googleConfig = resolveGoogleLoginConfig();
    const emailConfig = resolveEmailAuthConfig();
    const passwordLoginEnabled = isPasswordLoginEnabled();
    assertUsableInteractiveAuth({
        email: emailConfig,
        googleClientId: googleConfig.clientId,
        passwordLoginEnabled,
    });
    app.addHook('onReady', async () => {
        if (passwordLoginEnabled) return;
        const replacementProviders = enabledReplacementIdentityProviders(emailConfig !== null, googleConfig.clientId !== null);
        const providerSql = replacementProviders.map((provider) => `'${provider}'`).join(', ');
        const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT COUNT(*)::bigint AS count
             FROM "AccountCredential" credential
             WHERE NOT EXISTS (
                 SELECT 1 FROM "AccountIdentity" replacement
                 WHERE replacement."accountId" = credential."accountId"
                   AND replacement."provider" IN (${providerSql})
               )`,
        );
        if (Number(rows[0]?.count ?? 0) > 0) {
            throw new Error('AUTH_PASSWORD_LOGIN_DISABLED cannot be enabled while password-only accounts exist');
        }
    });
    app.get('/v1/auth/config', {
        schema: {
            response: {
                200: z.object({
                    googleClientId: z.string().optional(),
                    emailOtpEnabled: z.boolean(),
                    passwordLoginEnabled: z.boolean(),
                    signup: z.object({
                        mode: z.enum(['open', 'invite', 'closed']),
                        maxAccounts: z.number().int().nullable(),
                        registeredAccounts: z.number().int(),
                        remainingAccounts: z.number().int().nullable(),
                        atCapacity: z.boolean(),
                    }),
                }),
            },
        },
    }, async (_request, reply) => {
        const status = await getSignupStatus();
        const googleClientId = googleConfig.clientId ?? undefined;
        return reply.send({
            googleClientId,
            emailOtpEnabled: emailConfig !== null,
            passwordLoginEnabled,
            signup: status,
        });
    });

    app.post('/v1/auth/email/code', {
        schema: {
            body: z.object({ email: emailSchema }).strict(),
            response: {
                200: z.object({ challengeId: z.string(), expiresAt: z.string() }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('email_not_configured') }),
                503: z.object({ error: z.literal('email_delivery_unavailable') }),
            },
        },
    }, async (request, reply) => {
        if (!emailConfig) return reply.code(501).send({ error: 'email_not_configured' as const });
        const email = normalizeEmail(request.body.email);
        const allowed = await consumeRateBucketsSequentially(emailCodeRateBuckets(request.ip, email, emailConfig));
        if (!allowed) return reply.code(429).send({ error: 'too_many_requests' as const });

        let challenge: Awaited<ReturnType<typeof createEmailLoginChallenge>>;
        try {
            challenge = await createEmailLoginChallenge(email, emailConfig.ttlMinutes, {
                maxPendingChallenges: emailConfig.maxPendingChallenges,
            });
        } catch (error) {
            if (error instanceof EmailLoginChallengeCapacityError) {
                return reply.code(429).send({ error: 'too_many_requests' as const });
            }
            throw error;
        }
        try {
            await sendLoginCode(emailConfig, {
                to: email,
                code: challenge.code,
                expiresInMinutes: emailConfig.ttlMinutes,
                idempotencyKey: challenge.id,
            });
        } catch (error) {
            await deleteEmailLoginChallenge(challenge.id).catch(() => undefined);
            if (error instanceof EmailDeliveryError) {
                log({ module: 'email-auth', level: 'warn', provider: emailConfig.provider }, 'Email login code delivery failed');
                return reply.code(503).send({ error: 'email_delivery_unavailable' as const });
            }
            throw error;
        }
        return reply.send({ challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString() });
    });

    app.post('/v1/auth/google/challenge', {
        schema: {
            response: {
                200: z.object({ nonce: z.string(), expiresAt: z.string() }),
                403: z.object({ error: z.literal('origin_not_allowed') }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('google_not_configured') }),
            },
        },
    }, async (request, reply) => {
        if (!googleConfig.clientId) return reply.code(501).send({ error: 'google_not_configured' as const });
        if (!isGoogleOriginAllowed(request.headers.origin, googleConfig)) {
            return reply.code(403).send({ error: 'origin_not_allowed' as const });
        }
        const challengeBucket = googleChallengeRateBucket(request.ip);
        if (!(await allowAuthRequest(challengeBucket.key, challengeBucket))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        try {
            const challenge = await issueGoogleLoginChallenge();
            return reply.send({ nonce: challenge.nonce, expiresAt: challenge.expiresAt.toISOString() });
        } catch (error) {
            if (error instanceof GoogleLoginChallengeCapacityError) {
                return reply.code(429).send({ error: 'too_many_requests' as const });
            }
            throw error;
        }
    });

    app.post('/v1/account/signup/password', {
        schema: {
            body: z.object({
                username: newUsernameSchema,
                password: passwordSchema,
                secret: z.string().min(40).max(48),
                inviteCode: z.string().trim().max(256).optional(),
            }).strict(),
            response: {
                200: loginResponse,
                400: z.object({ error: z.literal('invalid_secret') }),
                403: z.object({ error: z.enum(['signup-closed', 'invite-required', 'capacity-reached', 'password_login_disabled']) }),
                409: z.object({ error: z.literal('username_taken') }),
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
        if (!passwordLoginEnabled) return reply.code(403).send({ error: 'password_login_disabled' as const });
        const username = request.body.username;
        const publicKey = accountPublicKeyFromSecret(request.body.secret);
        if (!publicKey) return reply.code(400).send({ error: 'invalid_secret' as const });
        const ipKey = hashPairingValue(request.ip).slice(0, 32);
        const usernameKey = hashPairingValue(username).slice(0, 32);
        const allowed = await consumeRateBucketsSequentially([
            { key: `password-signup:ip:${ipKey}`, max: 5 },
            { key: `password-signup:user:${usernameKey}`, max: 3 },
            { key: 'password-signup:global', max: 50 },
        ]);
        if (!allowed) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }

        try {
            const passwordHash = await hashPassword(request.body.password);
            const result = await withSignupGate<{ accountId: string; session: { token: string; expiresAt: Date } }>({
                provider: 'password',
                inviteCode: request.body.inviteCode,
                findExisting: async (tx) => {
                    const existing = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                        'SELECT "accountId" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
                        username,
                    );
                    if (existing[0]) throw new UsernameTakenError();
                    return null;
                },
                create: async (tx) => {
                    const account = await tx.account.create({ data: { publicKey } });
                    const secretEnc = await upsertAccountSecret(tx, account.id, request.body.secret);
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AccountCredential"
                         ("username", "accountId", "passwordHash", "secretEnc", "updatedAt")
                         VALUES ($1, $2, $3, $4, now())`,
                        username,
                        account.id,
                        passwordHash,
                        secretEnc,
                    );
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AccountIdentity"
                         ("id", "accountId", "provider", "providerSubject", "updatedAt")
                         VALUES ($1, $2, 'password', $3, now())`,
                        randomUUID(),
                        account.id,
                        username,
                    );
                    const session = await auth.createLoginToken(account.id, tx, { cache: false });
                    return { accountId: account.id, session };
                },
                onRejected: (reason, provider) => signupRejectionsCounter.inc({ reason, provider }),
            });
            const session = result.value.session;
            return reply.send({
                token: session.token,
                secret: request.body.secret,
                expiresAt: session.expiresAt.toISOString(),
            });
        } catch (error) {
            if (error instanceof UsernameTakenError) {
                return reply.code(409).send({ error: 'username_taken' as const });
            }
            if (error instanceof SignupPolicyError) {
                return reply.code(403).send({ error: error.reason });
            }
            if ((error as { code?: string }).code === 'P2002' || /unique constraint/i.test(String(error))) {
                return reply.code(409).send({ error: 'username_taken' as const });
            }
            throw error;
        }
    });

    app.post('/v1/account/credentials', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                username: newUsernameSchema,
                password: passwordSchema,
                secret: z.string().min(1).max(1024),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    token: z.string().optional(),
                    secret: z.string().optional(),
                    expiresAt: z.string().optional(),
                }),
                400: z.object({ error: z.literal('invalid_secret') }),
                403: z.object({ error: z.enum(['reauth_required', 'password_login_disabled']) }),
                409: z.object({ error: z.literal('username_taken') }),
                429: z.object({ error: z.literal('too_many_requests') }),
                500: z.object({ error: z.literal('failed') }),
            },
        },
    }, async (request, reply) => {
        if (!passwordLoginEnabled) return reply.code(403).send({ error: 'password_login_disabled' as const });
        const accountId = request.userId;
        const username = request.body.username;
        const derivedPublicKey = accountPublicKeyFromSecret(request.body.secret);
        if (!derivedPublicKey) {
            return reply.code(400).send({ error: 'invalid_secret' as const });
        }
        try {
            // Account.publicKey is the immutable identity anchor. Never accept a
            // recoverable credential seed for some other account: doing so would
            // make the next password login return a secret that cannot decrypt
            // this account and could bind the wrong cryptographic identity.
            const account = await db.account.findUnique({
                where: { id: accountId },
                select: {
                    publicKey: true,
                    AccountIdentity: { select: { provider: true } },
                },
            });
            if (!account || account.publicKey.toLowerCase() !== derivedPublicKey) {
                return reply.code(400).send({ error: 'invalid_secret' as const });
            }

            // A legacy key-only account needs one bootstrap path to attach its
            // first recoverable login. Once password or Google identity exists,
            // this sensitive operation requires a login session created in the
            // last 10 minutes. A stolen 30-day bearer cannot silently become a
            // permanent attacker-selected password.
            const hasRecoverableIdentity = account.AccountIdentity.some(
                (identity) => identity.provider === 'password' || identity.provider === 'google' || identity.provider === 'email',
            );
            if (hasRecoverableIdentity) {
                const loginSessionId = request.authLoginSessionId;
                if (!(await hasRecentLoginSession(accountId, loginSessionId))) {
                    return reply.code(403).send({ error: 'reauth_required' as const });
                }
            }

            const credentialChangeRate = configuredResourceLimit(
                'MAX_CREDENTIAL_CHANGES_PER_ACCOUNT_PER_MINUTE',
                5,
            );
            if (credentialChangeRate > 0 && !(await allowAuthRequest(
                `credential-change:${accountId}`,
                { max: credentialChangeRate, windowMs: 60_000 },
            ))) {
                return reply.code(429).send({ error: 'too_many_requests' as const });
            }

            const passwordHash = await hashPassword(request.body.password);
            const session = await db.$transaction(async (tx) => {
                // One account has exactly one current password identity. The row
                // lock makes two concurrent credential changes deterministic;
                // Google and future non-password identities remain untouched.
                await tx.$queryRawUnsafe(
                    'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
                    accountId,
                );
                const existing = await tx.$queryRawUnsafe<{ accountId: string }[]>(
                    'SELECT "accountId" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
                    username,
                );
                if (existing[0] && existing[0].accountId !== accountId) {
                    throw new UsernameTakenError();
                }

                const secretEnc = await upsertAccountSecret(tx, accountId, request.body.secret);
                await tx.$executeRawUnsafe('DELETE FROM "AccountCredential" WHERE "accountId" = $1', accountId);
                await tx.$executeRawUnsafe(
                    `INSERT INTO "AccountCredential"
                     ("username", "accountId", "passwordHash", "secretEnc", "updatedAt")
                     VALUES ($1, $2, $3, $4, now())`,
                    username,
                    accountId,
                    passwordHash,
                    secretEnc,
                );
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AccountIdentity"
                     WHERE "provider" = 'password'
                       AND ("accountId" = $1 OR "providerSubject" = $2)`,
                    accountId,
                    username,
                );
                await tx.$executeRawUnsafe(
                    `INSERT INTO "AccountIdentity"
                     ("id", "accountId", "provider", "providerSubject", "updatedAt")
                     VALUES ($1, $2, 'password', $3, now())`,
                    randomUUID(),
                    accountId,
                    username,
                );
                await tx.$executeRawUnsafe(
                    `UPDATE "AccountLoginSession"
                     SET "revokedAt" = COALESCE("revokedAt", now())
                     WHERE "accountId" = $1 AND "revokedAt" IS NULL`,
                    accountId,
                );
                return auth.createLoginToken(accountId, tx, { cache: false });
            });
            auth.invalidateUserTokens(accountId);
            return reply.send({
                success: true as const,
                token: session.token,
                secret: request.body.secret,
                expiresAt: session.expiresAt.toISOString(),
            });
        } catch (error) {
            if (error instanceof UsernameTakenError ||
                (error as { code?: string }).code === 'P2002' ||
                /unique constraint/i.test(String(error))) {
                return reply.code(409).send({ error: 'username_taken' as const });
            }
            log({ module: 'api', level: 'error', error }, 'Account credentials upsert failed');
            return reply.code(500).send({ error: 'failed' as const });
        }
    });

    app.get('/v1/account/identities', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    email: z.string().nullable(),
                    google: z.object({ connected: z.boolean(), email: z.string().nullable() }),
                    passwordConfigured: z.boolean(),
                }),
            },
        },
    }, async (request, reply) => {
        return reply.send(await getAccountLoginMethods(db, request.userId));
    });

    app.post('/v1/account/login/refresh', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                secret: z.string().min(1).max(1024),
            }).strict(),
            response: {
                200: loginResponse,
                400: z.object({ error: z.literal('invalid_secret') }),
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
        const accountId = request.userId;
        if (!(await matchesAccountSecret(accountId, request.body.secret))) {
            return reply.code(400).send({ error: 'invalid_secret' as const });
        }
        const accountKey = hashPairingValue(accountId).slice(0, 32);
        if (!(await consumeRateBucketsSequentially([
            { key: `login-refresh:account:${accountKey}:minute`, max: 5 },
            { key: `login-refresh:account:${accountKey}:day`, max: 20, windowMs: 24 * 60 * 60_000 },
        ]))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }

        const session = await db.$transaction(async (tx) => {
            // Some accounts predate AccountSecret and login-session tracking. A
            // still-authenticated client can prove possession of the immutable
            // account seed above, so repair stale recovery material before
            // issuing a short-lived elevation session for identity changes.
            const secretEnc = await upsertAccountSecret(tx, accountId, request.body.secret);
            await tx.$executeRawUnsafe(
                'UPDATE "AccountCredential" SET "secretEnc" = $1, "updatedAt" = now() WHERE "accountId" = $2',
                secretEnc,
                accountId,
            );
            return auth.createLoginToken(accountId, tx, { cache: false });
        });
        return reply.send({
            token: session.token,
            secret: request.body.secret,
            expiresAt: session.expiresAt.toISOString(),
        });
    });

    app.post('/v1/account/identities/email', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                email: emailSchema,
                challengeId: z.string().uuid(),
                code: emailCodeSchema,
                secret: z.string().min(1).max(1024),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true), email: z.string() }),
                400: z.object({ error: z.literal('invalid_secret') }),
                401: z.object({ error: z.literal('invalid_email_code') }),
                403: z.object({ error: z.literal('reauth_required') }),
                409: z.object({ error: z.literal('email_identity_in_use') }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('email_not_configured') }),
            },
        },
    }, async (request, reply) => {
        if (!emailConfig) return reply.code(501).send({ error: 'email_not_configured' as const });
        const accountId = request.userId;
        if (!(await hasRecentLoginSession(accountId, request.authLoginSessionId))) {
            return reply.code(403).send({ error: 'reauth_required' as const });
        }
        if (!(await matchesAccountSecret(accountId, request.body.secret))) {
            return reply.code(400).send({ error: 'invalid_secret' as const });
        }

        const email = normalizeEmail(request.body.email);
        const accountKey = hashPairingValue(accountId).slice(0, 32);
        const allowed = await consumeRateBucketsSequentially([
            ...emailVerifyRateBuckets(request.ip, email, request.body.challengeId),
            { key: `email-link:account:${accountKey}:hour`, max: 5, windowMs: 60 * 60_000 },
            { key: `email-link:account:${accountKey}:day`, max: 10, windowMs: 24 * 60 * 60_000 },
        ]);
        if (!allowed) return reply.code(429).send({ error: 'too_many_requests' as const });
        try {
            const result = await linkVerifiedEmailIdentity(db, accountId, {
                email,
                challengeId: request.body.challengeId,
                code: request.body.code,
            });
            if (result === 'invalid-code') {
                return reply.code(401).send({ error: 'invalid_email_code' as const });
            }
        } catch (error) {
            if (error instanceof EmailIdentityInUseError) {
                return reply.code(409).send({ error: 'email_identity_in_use' as const });
            }
            throw error;
        }
        log({ module: 'email-auth', accountId }, 'Email login identity linked');
        return reply.send({ success: true as const, email });
    });

    app.post('/v1/account/identities/google', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                credential: z.string().min(1).max(16_384),
                nonce: z.string().min(32).max(256),
                secret: z.string().min(1).max(1024),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true), email: z.string().nullable() }),
                400: z.object({ error: z.literal('invalid_secret') }),
                401: z.object({ error: z.literal('invalid_google_credential') }),
                403: z.object({ error: z.enum(['reauth_required', 'origin_not_allowed']) }),
                409: z.object({ error: z.literal('google_identity_in_use') }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('google_not_configured') }),
            },
        },
    }, async (request, reply) => {
        const clientId = googleConfig.clientId;
        if (!clientId) return reply.code(501).send({ error: 'google_not_configured' as const });
        if (!isGoogleOriginAllowed(request.headers.origin, googleConfig)) {
            return reply.code(403).send({ error: 'origin_not_allowed' as const });
        }
        const accountId = request.userId;
        if (!(await hasRecentLoginSession(accountId, request.authLoginSessionId))) {
            return reply.code(403).send({ error: 'reauth_required' as const });
        }
        if (!(await matchesAccountSecret(accountId, request.body.secret))) {
            return reply.code(400).send({ error: 'invalid_secret' as const });
        }
        const accountKey = hashPairingValue(accountId).slice(0, 32);
        const allowed = await consumeRateBucketsSequentially([
            { key: `google-link:ip:${hashPairingValue(request.ip).slice(0, 32)}:minute`, max: 10 },
            { key: `google-link:account:${accountKey}:hour`, max: 5, windowMs: 60 * 60_000 },
            { key: `google-link:account:${accountKey}:day`, max: 10, windowMs: 24 * 60 * 60_000 },
            { key: 'google-link:global:hour', max: 300, windowMs: 60 * 60_000 },
        ]);
        if (!allowed) return reply.code(429).send({ error: 'too_many_requests' as const });

        let claims;
        try {
            claims = await verifyGoogleIdToken(request.body.credential, clientId, {
                expectedNonce: request.body.nonce,
            });
        } catch (error) {
            log({ module: 'google-auth', level: 'warn', error }, 'Google credential rejected while linking');
            return reply.code(401).send({ error: 'invalid_google_credential' as const });
        }
        try {
            const result = await linkVerifiedGoogleIdentity(db, accountId, {
                nonce: request.body.nonce,
                claims,
            });
            if (result === 'invalid-challenge') {
                return reply.code(401).send({ error: 'invalid_google_credential' as const });
            }
        } catch (error) {
            if (error instanceof GoogleIdentityInUseError) {
                return reply.code(409).send({ error: 'google_identity_in_use' as const });
            }
            throw error;
        }
        log({ module: 'google-auth', accountId }, 'Google login identity linked');
        return reply.send({ success: true as const, email: claims.email ?? null });
    });

    app.post('/v1/account/login', {
        schema: {
            body: z.object({
                username: loginUsernameSchema,
                // Keep login compatible with any historical 1–7 character
                // password while bounding request cost. New passwords require 8.
                password: z.string().min(1).max(256),
            }),
            response: {
                200: loginResponse,
                401: z.object({ error: z.literal('invalid_credentials') }),
                403: z.object({ error: z.literal('password_login_disabled') }),
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
        if (!passwordLoginEnabled) return reply.code(403).send({ error: 'password_login_disabled' as const });
        const username = request.body.username;
        const allowed = await consumeRateBucketsSequentially(passwordLoginRateBuckets(request.ip, username));
        if (!allowed) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        const rows = await db.$queryRawUnsafe<Array<{ accountId: string; passwordHash: string; secretEnc: string }>>(
            'SELECT "accountId", "passwordHash", "secretEnc" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
            username,
        );
        const row = rows[0];
        const passwordMatches = row
            ? await verifyPassword(request.body.password, row.passwordHash)
            : (await burnMissingPasswordLookup(request.body.password), false);
        if (!row || !passwordMatches) {
            return reply.code(401).send({ error: 'invalid_credentials' as const });
        }

        const secret = await db.$transaction(async (tx) => {
            const loaded = await loadAccountSecret(tx, row.accountId, row.secretEnc);
            await tx.$executeRawUnsafe(
                `INSERT INTO "AccountIdentity"
                 ("id", "accountId", "provider", "providerSubject", "updatedAt")
                 VALUES ($1, $2, 'password', $3, now())
                 ON CONFLICT ("provider", "providerSubject") DO NOTHING`,
                randomUUID(),
                row.accountId,
                username,
            );
            return loaded;
        });
        if (!secret) return reply.code(401).send({ error: 'invalid_credentials' as const });
        const session = await auth.createLoginToken(row.accountId);
        return reply.send({ token: session.token, secret, expiresAt: session.expiresAt.toISOString() });
    });

    app.post('/v1/account/login/email', {
        schema: {
            body: z.object({
                email: emailSchema,
                challengeId: z.string().uuid(),
                code: emailCodeSchema,
                inviteCode: z.string().trim().max(256).optional(),
            }).strict(),
            response: {
                200: loginResponse,
                401: z.object({ error: z.literal('invalid_email_code') }),
                403: z.object({ error: z.enum(['signup-closed', 'invite-required', 'capacity-reached']) }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('email_not_configured') }),
            },
        },
    }, async (request, reply) => {
        if (!emailConfig) return reply.code(501).send({ error: 'email_not_configured' as const });
        const email = normalizeEmail(request.body.email);
        const allowed = await consumeRateBucketsSequentially(emailVerifyRateBuckets(request.ip, email, request.body.challengeId));
        if (!allowed) return reply.code(429).send({ error: 'too_many_requests' as const });
        if (!(await consumeEmailLoginChallenge(request.body.challengeId, email, request.body.code))) {
            return reply.code(401).send({ error: 'invalid_email_code' as const });
        }

        type EmailAccount = { accountId: string; secret: string; session: { token: string; expiresAt: Date } };
        let result: { value: EmailAccount; created: boolean };
        try {
            result = await withSignupGate<EmailAccount>({
                provider: 'email',
                inviteCode: request.body.inviteCode,
                findExisting: async (tx) => {
                    const identities = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                        `SELECT "accountId" FROM "AccountIdentity"
                         WHERE "provider" = 'email' AND "providerSubject" = $1 LIMIT 1`,
                        email,
                    );
                    if (!identities[0]) return null;
                    const secret = await loadAccountSecret(tx, identities[0].accountId);
                    if (!secret) throw new Error('email-account-secret-missing');
                    const session = await auth.createLoginToken(identities[0].accountId, tx, { cache: false });
                    return { accountId: identities[0].accountId, secret, session };
                },
                create: async (tx) => {
                    const secretBytes = randomBytes(32);
                    const secret = secretBytes.toString('base64url');
                    const publicKey = tweetnacl.sign.keyPair.fromSeed(secretBytes).publicKey;
                    const account = await tx.account.create({
                        data: { publicKey: Buffer.from(publicKey).toString('hex') },
                    });
                    await upsertAccountSecret(tx, account.id, secret);
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AccountIdentity"
                         ("id", "accountId", "provider", "providerSubject", "email", "updatedAt")
                         VALUES ($1, $2, 'email', $3, $3, now())`,
                        randomUUID(), account.id, email,
                    );
                    const session = await auth.createLoginToken(account.id, tx, { cache: false });
                    return { accountId: account.id, secret, session };
                },
                onRejected: (reason, provider) => signupRejectionsCounter.inc({ reason, provider }),
            });
        } catch (error) {
            if (error instanceof SignupPolicyError) return reply.code(403).send({ error: error.reason });
            throw error;
        }
        const session = result.value.session;
        return reply.send({
            token: session.token,
            secret: result.value.secret,
            expiresAt: session.expiresAt.toISOString(),
        });
    });

    app.post('/v1/account/login/google', {
        schema: {
            body: z.object({
                credential: z.string().min(1).max(16_384),
                nonce: z.string().min(32).max(256),
                inviteCode: z.string().trim().max(256).optional(),
            }),
            response: {
                200: loginResponse,
                401: z.object({ error: z.literal('invalid_google_credential') }),
                403: z.object({ error: z.enum(['signup-closed', 'invite-required', 'capacity-reached', 'origin_not_allowed']) }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('google_not_configured') }),
            },
        },
    }, async (request, reply) => {
        const clientId = googleConfig.clientId;
        if (!clientId) return reply.code(501).send({ error: 'google_not_configured' as const });
        if (!isGoogleOriginAllowed(request.headers.origin, googleConfig)) {
            return reply.code(403).send({ error: 'origin_not_allowed' as const });
        }
        const loginBucket = googleLoginRateBucket(request.ip);
        if (!(await allowAuthRequest(loginBucket.key, loginBucket))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }

        let claims;
        try {
            claims = await verifyGoogleIdToken(request.body.credential, clientId, {
                expectedNonce: request.body.nonce,
            });
        } catch (error) {
            log({ module: 'google-auth', level: 'warn', error }, 'Google credential rejected');
            return reply.code(401).send({ error: 'invalid_google_credential' as const });
        }
        if (!(await consumeGoogleLoginChallenge(db, request.body.nonce))) {
            return reply.code(401).send({ error: 'invalid_google_credential' as const });
        }

        type GoogleAccount = { accountId: string; secret: string; session: { token: string; expiresAt: Date } };
        let result: { value: GoogleAccount; created: boolean };
        try {
            result = await withSignupGate<GoogleAccount>({
                provider: 'google',
                inviteCode: request.body.inviteCode,
                findExisting: async (tx) => {
                    const identities = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                        `SELECT "accountId" FROM "AccountIdentity"
                         WHERE "provider" = 'google' AND "providerSubject" = $1 LIMIT 1`,
                        claims.sub,
                    );
                    if (!identities[0]) return null;
                    const secret = await loadAccountSecret(tx, identities[0].accountId);
                    if (!secret) throw new Error('google-account-secret-missing');
                    const session = await auth.createLoginToken(identities[0].accountId, tx, { cache: false });
                    return { accountId: identities[0].accountId, secret, session };
                },
                create: async (tx) => {
                    const secretBytes = randomBytes(32);
                    const secret = secretBytes.toString('base64url');
                    const tweetnacl = (await import('tweetnacl')).default;
                    const publicKey = tweetnacl.sign.keyPair.fromSeed(secretBytes).publicKey;
                    const account = await tx.account.create({
                        data: {
                            publicKey: Buffer.from(publicKey).toString('hex'),
                            firstName: claims.name,
                        },
                    });
                    await upsertAccountSecret(tx, account.id, secret);
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AccountIdentity"
                         ("id", "accountId", "provider", "providerSubject", "email", "profile", "updatedAt")
                         VALUES ($1, $2, 'google', $3, $4, $5::jsonb, now())`,
                        randomUUID(),
                        account.id,
                        claims.sub,
                        claims.email ?? null,
                        JSON.stringify({ name: claims.name, picture: claims.picture, emailVerified: claims.emailVerified }),
                    );
                    const session = await auth.createLoginToken(account.id, tx, { cache: false });
                    return { accountId: account.id, secret, session };
                },
                onRejected: (reason, provider) => signupRejectionsCounter.inc({ reason, provider }),
            });
        } catch (error) {
            if (error instanceof SignupPolicyError) {
                return reply.code(403).send({ error: error.reason });
            }
            throw error;
        }

        const session = result.value.session;
        return reply.send({
            token: session.token,
            secret: result.value.secret,
            expiresAt: session.expiresAt.toISOString(),
        });
    });

    app.post('/v1/account/logout', {
        preHandler: app.authenticate,
        schema: { response: { 200: z.object({ success: z.literal(true) }) } },
    }, async (request, reply) => {
        const authorization = request.headers.authorization;
        if (authorization?.startsWith('Bearer ')) {
            await auth.revokeLoginToken(authorization.slice(7), request.userId);
        }
        return reply.send({ success: true as const });
    });
}

export { hashPassword, verifyPassword };
