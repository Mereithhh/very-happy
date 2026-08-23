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
    isGoogleOriginAllowed,
    issueGoogleLoginChallenge,
    resolveGoogleLoginConfig,
} from '@/app/auth/googleLoginSecurity';
import { signupRejectionsCounter } from '@/app/monitoring/metrics2';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { decodeFixedBase64, hashPairingValue } from '@/app/auth/pairingSecurity';

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
    buckets: ReadonlyArray<{ key: string; max: number }>,
    consume: typeof allowAuthRequest = allowAuthRequest,
): Promise<boolean> {
    for (const bucket of buckets) {
        if (!(await consume(bucket.key, { max: bucket.max, windowMs: 60_000 }))) return false;
    }
    return true;
}

export function accountAuthRoutes(app: Fastify) {
    // Fail startup on a typo that could otherwise accidentally remove the cap.
    resolveSignupPolicy();
    const googleConfig = resolveGoogleLoginConfig();
    app.get('/v1/auth/config', {
        schema: {
            response: {
                200: z.object({
                    googleClientId: z.string().optional(),
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
        return reply.send({ googleClientId, signup: status });
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
        if (!(await allowAuthRequest(`google-challenge:${request.ip}`, { max: 60, windowMs: 60_000 }))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        const challenge = await issueGoogleLoginChallenge();
        return reply.send({ nonce: challenge.nonce, expiresAt: challenge.expiresAt.toISOString() });
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
                403: z.object({ error: z.enum(['signup-closed', 'invite-required', 'capacity-reached']) }),
                409: z.object({ error: z.literal('username_taken') }),
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
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
                409: z.object({ error: z.literal('username_taken') }),
                500: z.object({ error: z.literal('failed') }),
            },
        },
    }, async (request, reply) => {
        const accountId = request.userId;
        const username = request.body.username;
        try {
            const existing = await db.$queryRawUnsafe<{ accountId: string }[]>(
                'SELECT "accountId" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
                username,
            );
            if (existing[0] && existing[0].accountId !== accountId) {
                return reply.code(409).send({ error: 'username_taken' as const });
            }

            const passwordHash = await hashPassword(request.body.password);
            await db.$transaction(async (tx) => {
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
                    `INSERT INTO "AccountIdentity"
                     ("id", "accountId", "provider", "providerSubject", "updatedAt")
                     VALUES ($1, $2, 'password', $3, now())
                     ON CONFLICT ("provider", "providerSubject") DO NOTHING`,
                    randomUUID(),
                    accountId,
                    username,
                );
            });

            const session = await auth.createLoginToken(accountId);
            return reply.send({
                success: true as const,
                token: session.token,
                secret: request.body.secret,
                expiresAt: session.expiresAt.toISOString(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `account credentials upsert failed: ${error}`);
            return reply.code(500).send({ error: 'failed' as const });
        }
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
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
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
        if (!(await allowAuthRequest(`google-login:${request.ip}`, { max: 60, windowMs: 60_000 }))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }

        let claims;
        try {
            claims = await verifyGoogleIdToken(request.body.credential, clientId, {
                expectedNonce: request.body.nonce,
            });
        } catch (error) {
            log({ module: 'google-auth', level: 'warn' }, `Google credential rejected: ${(error as Error).message}`);
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
