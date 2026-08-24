import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
    ControlDeviceRootEnvelopeV1Schema,
    RecoveryKeyringCapsuleV1Schema,
    controlDeviceRootEnvelopeSignatureTranscript,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { hashPairingValue } from '@/app/auth/pairingSecurity';
import { burnMissingPasswordLookup, hashPassword, verifyPassword } from '@/app/auth/passwordAuth';
import { resolveE2eeSignupConfig } from '@/app/auth/e2eeConfig';
import {
    E2EE_CONTROL_CAPABILITY,
    E2EE_PENDING_LOGIN_TTL_MS,
    E2EE_PROTOCOL,
    E2EE_SUITE,
    E2EE_UNLOCK_CAPABILITY,
    E2eeSignupReservationCapacityError,
    consumeE2eeSignupReservation,
    contentKeyTranscript,
    decodeCanonicalBase64Url,
    issueE2eeSignupReservation,
    maxPendingE2eeDevicesPerAccount,
    normalizeE2eeOrigin,
    passwordSignupTranscript,
    recoveryCapsuleSignatureTranscript,
    rootEnvelopeTranscript,
    serializeControlDeviceRootEnvelope,
    serializeRecoveryCapsule,
    sha256Base64Url,
    verifyRecoveryAuthorityBytes,
    verifyRecoveryAuthoritySignature,
} from '@/app/auth/e2eeAuth';
import { SignupPolicyError, withSignupGate } from '@/app/auth/signupPolicy';
import { signupRejectionsCounter } from '@/app/monitoring/metrics2';
import type { Fastify } from '../types';

const usernameSchema = z.string().trim().toLowerCase().min(3).max(64).transform((value) => value.normalize('NFC'));
const loginUsernameSchema = z.string().trim().toLowerCase().min(1).max(64).transform((value) => value.normalize('NFC'));
const passwordSchema = z.string().min(8).max(256);
const canonical32Schema = z.string().length(43).refine(
    (value) => decodeCanonicalBase64Url(value, { exactBytes: 32 }) !== null,
    'Expected canonical unpadded base64url for 32 bytes',
);
const signatureSchema = z.string().length(86).refine(
    (value) => decodeCanonicalBase64Url(value, { exactBytes: 64 }) !== null,
    'Expected canonical unpadded base64url for 64 bytes',
);
const deviceSchema = z.object({
    id: z.string().uuid(),
    type: z.literal('web'),
    encryptionPublicKey: canonical32Schema,
    signingPublicKey: canonical32Schema,
}).strict();

const authV2Response = z.object({
    token: z.string(),
    expiresAt: z.string().optional(),
    accountId: z.string(),
    deviceId: z.string().optional(),
    capabilities: z.array(z.string()),
    cryptoMode: z.enum(['trusted-v1', 'e2ee-migrating', 'e2ee-v1']),
    cryptoEpoch: z.number().int().min(0),
    e2eeOrigin: z.string().optional(),
    recoveryAuthorityPublicKey: z.string().optional(),
    contentPublicKey: z.string().optional(),
    contentKeySignature: z.string().optional(),
    recoveryCapsule: RecoveryKeyringCapsuleV1Schema.optional(),
    legacySecret: z.string().optional(),
});

class UsernameTakenError extends Error {}
class InvalidReservationError extends Error {}
class DeviceConflictError extends Error {}
class PendingDeviceCapacityError extends Error {}

type E2eeAccountRow = {
    accountId: string;
    passwordHash: string;
    secretEnc: string | null;
    cryptoMode: 'trusted-v1' | 'e2ee-migrating' | 'e2ee-v1';
    cryptoEpoch: number;
    e2eeOrigin: string | null;
    recoveryAuthorityPublicKey: string | null;
    e2eeContentPublicKey: string | null;
    e2eeContentKeySignature: string | null;
    recoveryCiphertext: string | null;
};

function requestOrigin(request: { headers: { origin?: string } }): string | null {
    return normalizeE2eeOrigin(request.headers.origin);
}

function invalidCryptoMaterial(input: {
    recoveryAuthorityPublicKey: string;
    contentPublicKey: string;
    device: z.infer<typeof deviceSchema>;
}): boolean {
    return new Set([
        input.recoveryAuthorityPublicKey,
        input.contentPublicKey,
        input.device.encryptionPublicKey,
        input.device.signingPublicKey,
    ]).size !== 4;
}

async function loadCredential(username: string): Promise<E2eeAccountRow | null> {
    const rows = await db.$queryRawUnsafe<E2eeAccountRow[]>(
        `SELECT c."accountId", c."passwordHash", c."secretEnc",
                a."cryptoMode", a."cryptoEpoch", a."e2eeOrigin", a."recoveryAuthorityPublicKey",
                a."e2eeContentPublicKey", a."e2eeContentKeySignature", a."recoveryCiphertext"
         FROM "AccountCredential" c
         JOIN "Account" a ON a."id" = c."accountId"
         WHERE c."username" = $1 LIMIT 1`,
        username,
    );
    return rows[0] ?? null;
}

async function passwordRateAllowed(ip: string, username: string, action: 'signup' | 'login'): Promise<boolean> {
    const ipKey = hashPairingValue(ip).slice(0, 32);
    const usernameKey = hashPairingValue(username).slice(0, 32);
    const limits = action === 'signup' ? [5, 3, 50] : [20, 10, 200];
    const keys = [
        `e2ee-password-${action}:ip:${ipKey}`,
        `e2ee-password-${action}:user:${usernameKey}`,
        `e2ee-password-${action}:global`,
    ];
    for (let index = 0; index < keys.length; index += 1) {
        if (!(await allowAuthRequest(keys[index], { max: limits[index], windowMs: 60_000 }))) return false;
    }
    return true;
}

export function e2eeAccountAuthRoutes(app: Fastify) {
    // Validate booleans at startup. Both switches intentionally default false.
    resolveE2eeSignupConfig();

    app.post('/v2/account/signup/challenge', {
        schema: {
            response: {
                200: z.object({ accountId: z.string(), nonce: canonical32Schema, expiresAt: z.string(), suite: z.literal(E2EE_SUITE) }),
                400: z.object({ error: z.literal('invalid_origin') }),
                403: z.object({ error: z.literal('e2ee_signup_disabled') }),
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
        if (!resolveE2eeSignupConfig().enabled) {
            return reply.code(403).send({ error: 'e2ee_signup_disabled' as const });
        }
        const origin = requestOrigin(request);
        if (!origin) return reply.code(400).send({ error: 'invalid_origin' as const });
        if (!(await allowAuthRequest(`e2ee-signup-challenge:${hashPairingValue(request.ip).slice(0, 32)}`, { max: 10, windowMs: 60_000 }))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        try {
            const challenge = await issueE2eeSignupReservation(origin);
            return reply.send({
                accountId: challenge.accountId,
                nonce: challenge.nonce,
                expiresAt: challenge.expiresAt.toISOString(),
                suite: E2EE_SUITE,
            });
        } catch (error) {
            if (error instanceof E2eeSignupReservationCapacityError) {
                return reply.code(429).send({ error: 'too_many_requests' as const });
            }
            throw error;
        }
    });

    app.post('/v2/account/signup/password', {
        schema: {
            body: z.object({
                accountId: z.string().uuid(),
                nonce: canonical32Schema,
                username: usernameSchema,
                password: passwordSchema,
                recoveryAuthorityPublicKey: canonical32Schema,
                contentPublicKey: canonical32Schema,
                contentKeySignature: signatureSchema,
                recoveryCapsule: RecoveryKeyringCapsuleV1Schema,
                device: deviceSchema,
                rootEnvelope: ControlDeviceRootEnvelopeV1Schema,
                signupProof: signatureSchema,
                e2eeProtocol: z.literal(E2EE_PROTOCOL),
                inviteCode: z.string().trim().max(256).optional(),
            }).strict(),
            response: {
                200: authV2Response,
                400: z.object({ error: z.enum(['invalid_origin', 'invalid_crypto_proof', 'invalid_reservation']) }),
                403: z.object({ error: z.enum(['e2ee_signup_disabled', 'signup-closed', 'invite-required', 'capacity-reached']) }),
                409: z.object({ error: z.literal('username_taken') }),
                429: z.object({ error: z.literal('too_many_requests') }),
            },
        },
    }, async (request, reply) => {
        if (!resolveE2eeSignupConfig().enabled) {
            return reply.code(403).send({ error: 'e2ee_signup_disabled' as const });
        }
        const origin = requestOrigin(request);
        if (!origin) return reply.code(400).send({ error: 'invalid_origin' as const });
        const input = request.body;
        if (invalidCryptoMaterial(input)) {
            return reply.code(400).send({ error: 'invalid_crypto_proof' as const });
        }
        if (!(await passwordRateAllowed(request.ip, input.username, 'signup'))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        const signupTranscript = passwordSignupTranscript({
            origin,
            accountId: input.accountId,
            nonce: input.nonce,
            username: input.username,
            recoveryAuthorityPublicKey: input.recoveryAuthorityPublicKey,
            contentPublicKey: input.contentPublicKey,
            recoveryCapsule: input.recoveryCapsule,
            rootEnvelope: input.rootEnvelope,
            device: input.device,
        });
        const capsuleMatches = input.recoveryCapsule.origin === origin
            && input.recoveryCapsule.accountId === input.accountId
            && input.recoveryCapsule.currentEpoch === 1
            && input.recoveryCapsule.recoveryAuthorityPublicKey === input.recoveryAuthorityPublicKey;
        const rootEnvelopeMatches = input.rootEnvelope.origin === origin
            && input.rootEnvelope.accountId === input.accountId
            && input.rootEnvelope.deviceId === input.device.id
            && input.rootEnvelope.keyEpoch === 1
            && input.rootEnvelope.authorizer.kind === 'recovery';
        const proofsValid = capsuleMatches && rootEnvelopeMatches && verifyRecoveryAuthoritySignature(
            input.recoveryAuthorityPublicKey,
            input.signupProof,
            signupTranscript,
        ) && verifyRecoveryAuthoritySignature(
            input.recoveryAuthorityPublicKey,
            input.contentKeySignature,
            contentKeyTranscript({ origin, accountId: input.accountId, epoch: 1, contentPublicKey: input.contentPublicKey }),
        ) && verifyRecoveryAuthorityBytes(
            input.recoveryAuthorityPublicKey,
            input.recoveryCapsule.signature,
            recoveryCapsuleSignatureTranscript(input.recoveryCapsule),
        ) && verifyRecoveryAuthorityBytes(
            input.recoveryAuthorityPublicKey,
            input.rootEnvelope.signature,
            controlDeviceRootEnvelopeSignatureTranscript(input.rootEnvelope),
        );
        if (!proofsValid) return reply.code(400).send({ error: 'invalid_crypto_proof' as const });

        try {
            const passwordHash = await hashPassword(input.password);
            const result = await withSignupGate({
                provider: 'password' as const,
                inviteCode: input.inviteCode,
                findExisting: async (tx) => {
                    const existing = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                        'SELECT "accountId" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
                        input.username,
                    );
                    if (existing[0]) throw new UsernameTakenError();
                    return null;
                },
                create: async (tx) => {
                    if (!(await consumeE2eeSignupReservation(tx, { accountId: input.accountId, nonce: input.nonce, origin }))) {
                        throw new InvalidReservationError();
                    }
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "Account"
                         ("id", "publicKey", "cryptoMode", "cryptoEpoch", "cryptoWriteState", "e2eeOrigin",
                          "recoveryAuthorityPublicKey", "e2eeContentPublicKey", "e2eeContentKeySignature",
                          "recoveryCiphertext", "updatedAt")
                         VALUES ($1, NULL, 'e2ee-v1', 1, 'active', $2, $3, $4, $5, $6, now())`,
                        input.accountId,
                        origin,
                        input.recoveryAuthorityPublicKey,
                        input.contentPublicKey,
                        input.contentKeySignature,
                        serializeRecoveryCapsule(input.recoveryCapsule),
                    );
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AccountCredential"
                         ("username", "accountId", "passwordHash", "secretEnc", "updatedAt")
                         VALUES ($1, $2, $3, NULL, now())`,
                        input.username, input.accountId, passwordHash,
                    );
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AccountIdentity"
                         ("id", "accountId", "provider", "providerSubject", "updatedAt")
                         VALUES ($1, $2, 'password', $3, now())`,
                        randomUUID(), input.accountId, input.username,
                    );
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "CryptoDevice"
                         ("id", "accountId", "type", "encryptionPublicKey", "signingPublicKey",
                          "status", "keyEpoch", "updatedAt")
                         VALUES ($1, $2, 'web', $3, $4, 'active', 1, now())`,
                        input.device.id, input.accountId, input.device.encryptionPublicKey, input.device.signingPublicKey,
                    );
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "ControlDeviceRootEnvelope"
                         ("id", "accountId", "deviceId", "keyEpoch", "suite", "ciphertext",
                          "authorizerKind", "authorizerDeviceId", "signature", "updatedAt")
                         VALUES ($1, $2, $3, 1, $4, $5, 'recovery', NULL, $6, now())`,
                        randomUUID(), input.accountId, input.device.id, E2EE_SUITE,
                        serializeControlDeviceRootEnvelope(input.rootEnvelope), input.rootEnvelope.signature,
                    );
                    const session = await auth.createLoginToken(input.accountId, tx, {
                        cache: false,
                        deviceId: input.device.id,
                        capabilities: [E2EE_CONTROL_CAPABILITY],
                        e2eeProtocol: E2EE_PROTOCOL,
                    });
                    return { session };
                },
                onRejected: (reason, provider) => signupRejectionsCounter.inc({ reason, provider }),
            });
            const session = result.value.session;
            return reply.send({
                token: session.token,
                expiresAt: session.expiresAt.toISOString(),
                accountId: input.accountId,
                deviceId: input.device.id,
                capabilities: [E2EE_CONTROL_CAPABILITY],
                cryptoMode: 'e2ee-v1' as const,
                cryptoEpoch: 1,
                e2eeOrigin: origin,
                recoveryAuthorityPublicKey: input.recoveryAuthorityPublicKey,
                contentPublicKey: input.contentPublicKey,
                contentKeySignature: input.contentKeySignature,
                recoveryCapsule: input.recoveryCapsule,
            });
        } catch (error) {
            if (error instanceof UsernameTakenError || (error as { code?: string }).code === 'P2002') {
                return reply.code(409).send({ error: 'username_taken' as const });
            }
            if (error instanceof InvalidReservationError) {
                return reply.code(400).send({ error: 'invalid_reservation' as const });
            }
            if (error instanceof SignupPolicyError) return reply.code(403).send({ error: error.reason });
            throw error;
        }
    });

    app.post('/v2/account/login', {
        schema: {
            body: z.object({
                username: loginUsernameSchema,
                password: z.string().min(1).max(256),
                device: deviceSchema.optional(),
                e2eeProtocol: z.literal(E2EE_PROTOCOL).optional(),
            }).strict(),
            response: {
                200: authV2Response,
                400: z.object({ error: z.enum(['device_required', 'device_conflict']) }),
                401: z.object({ error: z.literal('invalid_credentials') }),
                429: z.object({ error: z.enum(['too_many_requests', 'too_many_pending_devices']) }),
            },
        },
    }, async (request, reply) => {
        const input = request.body;
        if (!(await passwordRateAllowed(request.ip, input.username, 'login'))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        const row = await loadCredential(input.username);
        const passwordMatches = row
            ? await verifyPassword(input.password, row.passwordHash)
            : (await burnMissingPasswordLookup(input.password), false);
        if (!row || !passwordMatches) return reply.code(401).send({ error: 'invalid_credentials' as const });

        if (row.cryptoMode !== 'e2ee-v1') {
            const { loadAccountSecret } = await import('@/app/auth/accountSecrets');
            const legacySecret = await db.$transaction((tx) => loadAccountSecret(tx, row.accountId, row.secretEnc ?? undefined));
            if (!legacySecret) return reply.code(401).send({ error: 'invalid_credentials' as const });
            const session = await auth.createLoginToken(row.accountId);
            return reply.send({
                token: session.token,
                expiresAt: session.expiresAt.toISOString(),
                accountId: row.accountId,
                capabilities: [],
                cryptoMode: row.cryptoMode,
                cryptoEpoch: row.cryptoEpoch,
                legacySecret,
            });
        }

        if (!input.device || input.e2eeProtocol !== E2EE_PROTOCOL) {
            return reply.code(400).send({ error: 'device_required' as const });
        }
        try {
            const session = await db.$transaction(async (tx) => {
                await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', row.accountId);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "CryptoDevice" d
                     WHERE d."accountId" = $1 AND d."status" = 'pending'
                       AND NOT EXISTS (
                         SELECT 1 FROM "AccountLoginSession" s
                         WHERE s."accountId" = d."accountId" AND s."deviceId" = d."id"
                           AND s."revokedAt" IS NULL AND s."expiresAt" > now()
                       )`,
                    row.accountId,
                );
                const pendingCounts = await tx.$queryRawUnsafe<Array<{ count: bigint | number | string }>>(
                    `SELECT COUNT(*) AS "count" FROM "CryptoDevice"
                     WHERE "accountId" = $1 AND "status" = 'pending'`,
                    row.accountId,
                );
                if (Number(pendingCounts[0]?.count ?? 0) >= maxPendingE2eeDevicesPerAccount()) {
                    throw new PendingDeviceCapacityError();
                }
                const conflicts = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                    'SELECT "accountId" FROM "CryptoDevice" WHERE "id" = $1 LIMIT 1',
                    input.device!.id,
                );
                if (conflicts[0]) throw new DeviceConflictError();
                await tx.$executeRawUnsafe(
                    `INSERT INTO "CryptoDevice"
                     ("id", "accountId", "type", "encryptionPublicKey", "signingPublicKey",
                      "status", "keyEpoch", "updatedAt")
                     VALUES ($1, $2, 'web', $3, $4, 'pending', $5, now())`,
                    input.device!.id, row.accountId, input.device!.encryptionPublicKey,
                    input.device!.signingPublicKey, row.cryptoEpoch,
                );
                return auth.createLoginToken(row.accountId, tx, {
                    cache: false,
                    deviceId: input.device!.id,
                    capabilities: [E2EE_UNLOCK_CAPABILITY],
                    e2eeProtocol: E2EE_PROTOCOL,
                    ttlMs: E2EE_PENDING_LOGIN_TTL_MS,
                });
            });
            return reply.send({
                token: session.token,
                expiresAt: session.expiresAt.toISOString(),
                accountId: row.accountId,
                deviceId: input.device.id,
                capabilities: [E2EE_UNLOCK_CAPABILITY],
                cryptoMode: 'e2ee-v1' as const,
                cryptoEpoch: row.cryptoEpoch,
                e2eeOrigin: row.e2eeOrigin!,
                recoveryAuthorityPublicKey: row.recoveryAuthorityPublicKey!,
                contentPublicKey: row.e2eeContentPublicKey!,
                contentKeySignature: row.e2eeContentKeySignature!,
                recoveryCapsule: RecoveryKeyringCapsuleV1Schema.parse(JSON.parse(row.recoveryCiphertext!)),
            });
        } catch (error) {
            if (error instanceof DeviceConflictError || (error as { code?: string }).code === 'P2002') {
                return reply.code(400).send({ error: 'device_conflict' as const });
            }
            if (error instanceof PendingDeviceCapacityError) {
                return reply.code(429).send({ error: 'too_many_pending_devices' as const });
            }
            throw error;
        }
    });

    app.post('/v2/account/device/activate', {
        schema: {
            body: z.object({
                deviceId: z.string().uuid(),
                e2eeProtocol: z.literal(E2EE_PROTOCOL),
                rootEnvelope: ControlDeviceRootEnvelopeV1Schema,
                activationProof: signatureSchema,
            }).strict(),
            response: {
                200: authV2Response,
                400: z.object({ error: z.enum(['invalid_origin', 'invalid_crypto_proof']) }),
                401: z.object({ error: z.literal('invalid_token') }),
                403: z.object({ error: z.literal('invalid_unlock_session') }),
            },
        },
    }, async (request, reply) => {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: 'invalid_token' as const });
        const oldToken = authorization.slice(7);
        const verified = await auth.verifyToken(oldToken);
        if (!verified) return reply.code(401).send({ error: 'invalid_token' as const });
        const extras = verified.extras;
        if (
            extras?.cryptoMode !== 'e2ee-v1'
            || extras.deviceId !== request.body.deviceId
            || extras.e2eeProtocol !== E2EE_PROTOCOL
            || extras.capabilities?.length !== 1
            || extras.capabilities[0] !== E2EE_UNLOCK_CAPABILITY
            || !extras.loginSessionId
        ) {
            return reply.code(403).send({ error: 'invalid_unlock_session' as const });
        }
        const origin = requestOrigin(request);
        if (!origin) return reply.code(400).send({ error: 'invalid_origin' as const });
        const rows = await db.$queryRawUnsafe<Array<{
            cryptoEpoch: number;
            e2eeOrigin: string;
            recoveryAuthorityPublicKey: string;
            e2eeContentPublicKey: string;
            e2eeContentKeySignature: string;
            recoveryCiphertext: string;
            id: string;
            type: 'web';
            encryptionPublicKey: string;
            signingPublicKey: string;
            status: string;
        }>>(
            `SELECT a."cryptoEpoch", a."e2eeOrigin", a."recoveryAuthorityPublicKey", a."e2eeContentPublicKey",
                    a."e2eeContentKeySignature", a."recoveryCiphertext",
                    d."id", d."type", d."encryptionPublicKey", d."signingPublicKey", d."status"
             FROM "Account" a JOIN "CryptoDevice" d ON d."accountId" = a."id"
             WHERE a."id" = $1 AND d."id" = $2 LIMIT 1`,
            verified.userId, request.body.deviceId,
        );
        const row = rows[0];
        if (!row || row.status !== 'pending' || row.type !== 'web') {
            return reply.code(403).send({ error: 'invalid_unlock_session' as const });
        }
        const envelopeMatches = origin === row.e2eeOrigin
            && request.body.rootEnvelope.origin === row.e2eeOrigin
            && request.body.rootEnvelope.accountId === verified.userId
            && request.body.rootEnvelope.deviceId === request.body.deviceId
            && request.body.rootEnvelope.keyEpoch === row.cryptoEpoch
            && request.body.rootEnvelope.authorizer.kind === 'recovery';
        const valid = envelopeMatches && verifyRecoveryAuthorityBytes(
            row.recoveryAuthorityPublicKey,
            request.body.rootEnvelope.signature,
            controlDeviceRootEnvelopeSignatureTranscript(request.body.rootEnvelope),
        ) && verifyRecoveryAuthoritySignature(
            row.recoveryAuthorityPublicKey,
            request.body.activationProof,
            rootEnvelopeTranscript({
                origin,
                accountId: verified.userId,
                epoch: row.cryptoEpoch,
                challenge: sha256Base64Url(oldToken),
                device: row,
                envelope: request.body.rootEnvelope,
            }),
        );
        if (!valid) {
            await db.cryptoDevice.deleteMany({
                where: { accountId: verified.userId, id: request.body.deviceId, status: 'pending' },
            });
            auth.invalidateToken(oldToken);
            return reply.code(400).send({ error: 'invalid_crypto_proof' as const });
        }

        const session = await db.$transaction(async (tx) => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', verified.userId);
            const updated = await tx.$executeRawUnsafe(
                `UPDATE "CryptoDevice" SET "status" = 'active', "keyEpoch" = $3, "updatedAt" = now()
                 WHERE "accountId" = $1 AND "id" = $2 AND "status" = 'pending'`,
                verified.userId, request.body.deviceId, row.cryptoEpoch,
            );
            if (updated !== 1) throw new DeviceConflictError();
            await tx.$executeRawUnsafe(
                `INSERT INTO "ControlDeviceRootEnvelope"
                 ("id", "accountId", "deviceId", "keyEpoch", "suite", "ciphertext",
                  "authorizerKind", "authorizerDeviceId", "signature", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, 'recovery', NULL, $7, now())`,
                randomUUID(), verified.userId, request.body.deviceId, row.cryptoEpoch,
                E2EE_SUITE, serializeControlDeviceRootEnvelope(request.body.rootEnvelope), request.body.rootEnvelope.signature,
            );
            await tx.$executeRawUnsafe(
                `UPDATE "AccountLoginSession" SET "revokedAt" = now()
                 WHERE "id" = $1 AND "accountId" = $2 AND "revokedAt" IS NULL`,
                extras.loginSessionId, verified.userId,
            );
            return auth.createLoginToken(verified.userId, tx, {
                cache: false,
                deviceId: request.body.deviceId,
                capabilities: [E2EE_CONTROL_CAPABILITY],
                e2eeProtocol: E2EE_PROTOCOL,
            });
        });
        auth.invalidateToken(oldToken);
        return reply.send({
            token: session.token,
            expiresAt: session.expiresAt.toISOString(),
            accountId: verified.userId,
            deviceId: request.body.deviceId,
            capabilities: [E2EE_CONTROL_CAPABILITY],
            cryptoMode: 'e2ee-v1' as const,
            cryptoEpoch: row.cryptoEpoch,
            e2eeOrigin: row.e2eeOrigin,
            recoveryAuthorityPublicKey: row.recoveryAuthorityPublicKey,
            contentPublicKey: row.e2eeContentPublicKey,
            contentKeySignature: row.e2eeContentKeySignature,
            recoveryCapsule: RecoveryKeyringCapsuleV1Schema.parse(JSON.parse(row.recoveryCiphertext)),
        });
    });
}
