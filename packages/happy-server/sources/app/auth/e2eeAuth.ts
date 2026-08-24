import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
    E2EE_SUITE_V1,
    RecoveryKeyringCapsuleV1Schema,
    canonicalizeE2eeJson,
    encodeCanonicalE2eeJson,
    type CanonicalJsonValue,
    type ControlDeviceRootEnvelopeV1,
    type RecoveryKeyringCapsuleV1,
} from '@slopus/happy-wire';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';

export const E2EE_SUITE = E2EE_SUITE_V1;
export const E2EE_PROTOCOL = E2EE_SUITE_V1;
export const E2EE_UNLOCK_CAPABILITY = 'e2ee:unlock' as const;
export const E2EE_CONTROL_CAPABILITY = 'e2ee:control' as const;
export const E2EE_PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

const E2EE_SIGNUP_CREATE_LOCK_KEY = 'e2ee-signup-reservation-create-cap';
const DEFAULT_MAX_PENDING_E2EE_SIGNUPS = 10_000;
const DEFAULT_E2EE_SIGNUP_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING_E2EE_DEVICES_PER_ACCOUNT = 20;

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
type CanonicalScalar = string | number | boolean | null;

export class E2eeSignupReservationCapacityError extends Error {
    constructor() {
        super('e2ee-signup-reservation-capacity');
        this.name = 'E2eeSignupReservationCapacityError';
    }
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}

export function maxPendingE2eeSignups(env: NodeJS.ProcessEnv = process.env): number {
    return positiveInt(env.MAX_PENDING_E2EE_SIGNUPS, DEFAULT_MAX_PENDING_E2EE_SIGNUPS, 1_000_000);
}

export function e2eeSignupTtlMs(env: NodeJS.ProcessEnv = process.env): number {
    return positiveInt(env.E2EE_SIGNUP_TTL_MINUTES, DEFAULT_E2EE_SIGNUP_TTL_MS / 60_000, 60) * 60_000;
}

export function maxPendingE2eeDevicesPerAccount(env: NodeJS.ProcessEnv = process.env): number {
    return positiveInt(
        env.MAX_PENDING_E2EE_DEVICES_PER_ACCOUNT,
        DEFAULT_MAX_PENDING_E2EE_DEVICES_PER_ACCOUNT,
        1_000,
    );
}

export function normalizeE2eeOrigin(value: string | undefined): string | null {
    if (!value || value.length > 512) return null;
    try {
        const parsed = new URL(value);
        const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
        if (parsed.origin === 'null' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

/** Strict, unpadded base64url decoding. Re-encoding rejects non-canonical aliases. */
export function decodeCanonicalBase64Url(value: string, options: { exactBytes?: number; minBytes?: number; maxBytes?: number }): Buffer | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    if (value.length > Math.ceil((options.maxBytes ?? options.exactBytes ?? 0) * 4 / 3) + 2) return null;
    try {
        const decoded = Buffer.from(value, 'base64url');
        if (options.exactBytes !== undefined && decoded.length !== options.exactBytes) return null;
        if (options.minBytes !== undefined && decoded.length < options.minBytes) return null;
        if (options.maxBytes !== undefined && decoded.length > options.maxBytes) return null;
        return decoded.toString('base64url') === value ? decoded : null;
    } catch {
        return null;
    }
}

/** RFC 8785 canonical form for the flat scalar transcript objects used here. */
export function canonicalizeE2eeTranscript(value: Record<string, CanonicalScalar>): Buffer {
    const canonical: Record<string, CanonicalScalar> = {};
    for (const key of Object.keys(value).sort()) canonical[key] = value[key];
    return Buffer.from(JSON.stringify(canonical), 'utf8');
}

export function sha256Base64Url(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('base64url');
}

export function verifyRecoveryAuthoritySignature(
    publicKeyValue: string,
    signatureValue: string,
    transcript: Record<string, CanonicalScalar>,
): boolean {
    const publicKey = decodeCanonicalBase64Url(publicKeyValue, { exactBytes: tweetnacl.sign.publicKeyLength });
    const signature = decodeCanonicalBase64Url(signatureValue, { exactBytes: tweetnacl.sign.signatureLength });
    if (!publicKey || !signature) return false;
    return tweetnacl.sign.detached.verify(
        canonicalizeE2eeTranscript(transcript),
        Uint8Array.from(signature),
        Uint8Array.from(publicKey),
    );
}

export function verifyRecoveryAuthorityBytes(
    publicKeyValue: string,
    signatureValue: string,
    transcript: Uint8Array,
): boolean {
    const publicKey = decodeCanonicalBase64Url(publicKeyValue, { exactBytes: tweetnacl.sign.publicKeyLength });
    const signature = decodeCanonicalBase64Url(signatureValue, { exactBytes: tweetnacl.sign.signatureLength });
    if (!publicKey || !signature) return false;
    return tweetnacl.sign.detached.verify(
        transcript,
        Uint8Array.from(signature),
        Uint8Array.from(publicKey),
    );
}

/** Store the complete authenticated container, never only its inner ciphertext. */
export function serializeRecoveryCapsule(capsule: RecoveryKeyringCapsuleV1): string {
    return canonicalizeE2eeJson(RecoveryKeyringCapsuleV1Schema.parse(capsule) as CanonicalJsonValue);
}

export function recoveryCapsuleSignatureTranscript(capsule: RecoveryKeyringCapsuleV1): Uint8Array {
    const parsed = RecoveryKeyringCapsuleV1Schema.parse(capsule);
    const { signature: _signature, ...unsigned } = parsed;
    return encodeCanonicalE2eeJson(unsigned);
}

export function serializeControlDeviceRootEnvelope(envelope: ControlDeviceRootEnvelopeV1): string {
    return canonicalizeE2eeJson(envelope as CanonicalJsonValue);
}

export interface E2eeDevicePublicInput {
    id: string;
    type: 'web';
    encryptionPublicKey: string;
    signingPublicKey: string;
}

export function contentKeyTranscript(input: {
    origin: string;
    accountId: string;
    epoch: number;
    contentPublicKey: string;
}): Record<string, CanonicalScalar> {
    return {
        accountId: input.accountId,
        contentPublicKey: input.contentPublicKey,
        domain: 'very-happy/vh-e2ee-1/content-key',
        epoch: input.epoch,
        origin: input.origin,
        suite: E2EE_SUITE,
    };
}

export function rootEnvelopeTranscript(input: {
    origin: string;
    accountId: string;
    epoch: number;
    challenge: string;
    device: E2eeDevicePublicInput;
    envelope: ControlDeviceRootEnvelopeV1;
}): Record<string, CanonicalScalar> {
    return {
        accountId: input.accountId,
        authorizerKind: 'recovery',
        capability: E2EE_CONTROL_CAPABILITY,
        challenge: input.challenge,
        envelopeHash: sha256Base64Url(serializeControlDeviceRootEnvelope(input.envelope)),
        deviceEncryptionPublicKey: input.device.encryptionPublicKey,
        deviceId: input.device.id,
        deviceSigningPublicKey: input.device.signingPublicKey,
        deviceType: input.device.type,
        domain: 'very-happy/vh-e2ee-1/device-root-envelope',
        epoch: input.epoch,
        origin: input.origin,
        suite: E2EE_SUITE,
    };
}

export function passwordSignupTranscript(input: {
    origin: string;
    accountId: string;
    nonce: string;
    username: string;
    recoveryAuthorityPublicKey: string;
    contentPublicKey: string;
    recoveryCapsule: RecoveryKeyringCapsuleV1;
    rootEnvelope: ControlDeviceRootEnvelopeV1;
    device: E2eeDevicePublicInput;
}): Record<string, CanonicalScalar> {
    return {
        accountId: input.accountId,
        capability: E2EE_CONTROL_CAPABILITY,
        contentPublicKey: input.contentPublicKey,
        deviceEncryptionPublicKey: input.device.encryptionPublicKey,
        deviceId: input.device.id,
        deviceSigningPublicKey: input.device.signingPublicKey,
        deviceType: input.device.type,
        domain: 'very-happy/vh-e2ee-1/signup',
        epoch: 1,
        normalizedIdentity: input.username,
        origin: input.origin,
        provider: 'password',
        recoveryAuthorityPublicKey: input.recoveryAuthorityPublicKey,
        recoveryCiphertextHash: sha256Base64Url(serializeRecoveryCapsule(input.recoveryCapsule)),
        rootEnvelopeCiphertextHash: sha256Base64Url(serializeControlDeviceRootEnvelope(input.rootEnvelope)),
        signupNonce: input.nonce,
        suite: E2EE_SUITE,
    };
}

export function hashE2eeSignupNonce(nonce: string): string {
    return createHash('sha256').update(nonce).digest('hex');
}

export async function issueE2eeSignupReservation(
    origin: string,
    client?: SqlClient,
    nowMs = Date.now(),
): Promise<{ accountId: string; nonce: string; expiresAt: Date }> {
    if (!client) return db.$transaction((tx) => issueE2eeSignupReservation(origin, tx, nowMs));
    const accountId = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(nowMs + e2eeSignupTtlMs());
    await client.$executeRawUnsafe(
        `INSERT INTO "GlobalLock" ("key", "value", "updatedAt", "expiresAt")
         VALUES ($1, $1, $2, $3)
         ON CONFLICT ("key") DO NOTHING`,
        E2EE_SIGNUP_CREATE_LOCK_KEY,
        new Date(nowMs),
        new Date('9999-12-31T23:59:59.999Z'),
    );
    await client.$queryRawUnsafe(
        'SELECT "key" FROM "GlobalLock" WHERE "key" = $1 FOR UPDATE',
        E2EE_SIGNUP_CREATE_LOCK_KEY,
    );
    await client.$executeRawUnsafe(
        'DELETE FROM "E2eeSignupReservation" WHERE "expiresAt" <= now() OR "consumedAt" IS NOT NULL',
    );
    const counts = await client.$queryRawUnsafe<Array<{ count: bigint | number | string }>>(
        'SELECT COUNT(*) AS "count" FROM "E2eeSignupReservation"',
    );
    if (Number(counts[0]?.count ?? 0) >= maxPendingE2eeSignups()) {
        throw new E2eeSignupReservationCapacityError();
    }
    await client.$executeRawUnsafe(
        `INSERT INTO "E2eeSignupReservation"
         ("id", "accountId", "nonceHash", "origin", "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        randomUUID(), accountId, hashE2eeSignupNonce(nonce), origin, expiresAt,
    );
    return { accountId, nonce, expiresAt };
}

/** Atomically consumes the exact unexpired account/nonce/origin reservation. */
export async function consumeE2eeSignupReservation(
    client: SqlClient,
    input: { accountId: string; nonce: string; origin: string },
): Promise<boolean> {
    const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "E2eeSignupReservation"
         SET "consumedAt" = now()
         WHERE "accountId" = $1 AND "nonceHash" = $2 AND "origin" = $3
           AND "consumedAt" IS NULL AND "expiresAt" > now()
         RETURNING "id"`,
        input.accountId, hashE2eeSignupNonce(input.nonce), input.origin,
    );
    return rows.length === 1;
}
