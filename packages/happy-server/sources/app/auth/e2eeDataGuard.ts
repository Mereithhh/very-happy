import {
    E2EE_SUITE_V1,
    StoredE2eeEnvelopeV1Schema,
    canonicalizeE2eeJson,
    type E2eeStoredDomain,
    type StoredE2eeEnvelopeV1,
} from '@slopus/happy-wire';
import type { Tx } from '@/storage/inTx';
import { decodePrismaBytes } from '@/storage/prismaBytes';

export const E2EE_CONTROL_CAPABILITY = 'e2ee:control' as const;

export type E2eeWriterAuth = {
    loginSessionId?: string;
    deviceId?: string;
    capabilities?: readonly string[];
    e2eeProtocol?: string;
};

export type AccountCryptoState = {
    id: string;
    cryptoMode: 'trusted-v1' | 'e2ee-migrating' | 'e2ee-v1';
    cryptoEpoch: number;
    cryptoWriteState: 'active' | 'rekey-required';
    e2eeOrigin: string | null;
};

export class E2eeDataGuardError extends Error {
    constructor(
        readonly statusCode: 400 | 409 | 426,
        readonly code: 'invalid_e2ee_envelope' | 'e2ee_data_invalid' | 'e2ee_rekey_required' | 'e2ee_client_required',
    ) {
        super(code);
        this.name = 'E2eeDataGuardError';
    }
}

export function isE2eeDataGuardError(error: unknown): error is E2eeDataGuardError {
    return error instanceof E2eeDataGuardError;
}

type ExpectedStoredEnvelope = {
    origin: string;
    accountId: string;
    epoch: number;
    domain: E2eeStoredDomain;
    objectId: string;
    field: string;
    maxSerializedBytes: number;
    epochPolicy?: 'current-write' | 'read-existing';
};

function decodeUtf8Strict(value: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

/**
 * Parse a complete stored envelope and require its wire representation to be
 * the one canonical JCS serialization. JSON.parse alone is insufficient: it
 * accepts duplicate keys, whitespace, non-canonical escapes, and arbitrary
 * member order that the frozen protocol explicitly rejects.
 */
export function parseCanonicalStoredE2eeEnvelope(
    serialized: string,
    expected: ExpectedStoredEnvelope,
    invalidCode: 'invalid_e2ee_envelope' | 'e2ee_data_invalid' = 'invalid_e2ee_envelope',
): StoredE2eeEnvelopeV1 {
    const statusCode = invalidCode === 'e2ee_data_invalid' ? 409 : 400;
    try {
        if (Buffer.byteLength(serialized, 'utf8') > expected.maxSerializedBytes) {
            throw new Error('oversize');
        }
        const parsedJson = JSON.parse(serialized) as unknown;
        const envelope = StoredE2eeEnvelopeV1Schema.parse(parsedJson);
        if (canonicalizeE2eeJson(envelope) !== serialized) throw new Error('non-canonical');
        if (
            envelope.origin !== expected.origin
            || envelope.accountId !== expected.accountId
            || (expected.epochPolicy === 'read-existing'
                ? envelope.epoch > expected.epoch
                : envelope.epoch !== expected.epoch)
            || envelope.domain !== expected.domain
            || envelope.objectId !== expected.objectId
            || envelope.field !== expected.field
        ) {
            throw new Error('context mismatch');
        }
        return envelope;
    } catch {
        throw new E2eeDataGuardError(statusCode, invalidCode);
    }
}

export function e2eeDomainForKvKey(key: string): 'tasks' | 'notes' | 'kv' {
    if (key === 'vh.board-tasks.v1') return 'tasks';
    if (key.startsWith('vh.note.v1.')) return 'notes';
    return 'kv';
}

export function validateE2eeSettingsValue(
    serialized: string,
    account: AccountCryptoState,
    maxSerializedBytes: number,
    invalidCode: 'invalid_e2ee_envelope' | 'e2ee_data_invalid' = 'invalid_e2ee_envelope',
    epochPolicy: 'current-write' | 'read-existing' = 'current-write',
): StoredE2eeEnvelopeV1 {
    if (!account.e2eeOrigin) throw new E2eeDataGuardError(409, 'e2ee_data_invalid');
    return parseCanonicalStoredE2eeEnvelope(serialized, {
        origin: account.e2eeOrigin,
        accountId: account.id,
        epoch: account.cryptoEpoch,
        domain: 'settings',
        objectId: account.id,
        field: 'settings',
        maxSerializedBytes,
        epochPolicy,
    }, invalidCode);
}

export function validateE2eeKvValue(
    base64Value: string,
    key: string,
    account: AccountCryptoState,
    maxSerializedBytes: number,
    invalidCode: 'invalid_e2ee_envelope' | 'e2ee_data_invalid' = 'invalid_e2ee_envelope',
    epochPolicy: 'current-write' | 'read-existing' = 'current-write',
): StoredE2eeEnvelopeV1 {
    if (!account.e2eeOrigin) throw new E2eeDataGuardError(409, 'e2ee_data_invalid');
    try {
        const serialized = decodeUtf8Strict(decodePrismaBytes(base64Value));
        return parseCanonicalStoredE2eeEnvelope(serialized, {
            origin: account.e2eeOrigin,
            accountId: account.id,
            epoch: account.cryptoEpoch,
            domain: e2eeDomainForKvKey(key),
            objectId: key,
            field: 'value',
            maxSerializedBytes,
            epochPolicy,
        }, invalidCode);
    } catch (error) {
        if (isE2eeDataGuardError(error)) throw error;
        throw new E2eeDataGuardError(invalidCode === 'e2ee_data_invalid' ? 409 : 400, invalidCode);
    }
}

type LockedWriterRow = {
    id: string;
    cryptoMode: string | null;
    cryptoEpoch: number | null;
    cryptoWriteState: string | null;
    e2eeOrigin: string | null;
    sessionId: string | null;
    sessionDeviceId: string | null;
    sessionCapabilities: string[] | null;
    sessionProtocol: string | null;
    sessionExpiresAt: Date | string | null;
    sessionRevokedAt: Date | string | null;
    deviceId: string | null;
    deviceStatus: string | null;
    deviceKeyEpoch: number | null;
    deviceRevokedAt: Date | string | null;
};

function normalizeAccountState(row: LockedWriterRow): AccountCryptoState {
    return {
        id: row.id,
        cryptoMode: (row.cryptoMode ?? 'trusted-v1') as AccountCryptoState['cryptoMode'],
        cryptoEpoch: row.cryptoEpoch ?? 0,
        cryptoWriteState: (row.cryptoWriteState ?? 'active') as AccountCryptoState['cryptoWriteState'],
        e2eeOrigin: row.e2eeOrigin ?? null,
    };
}

/**
 * Lock and re-read the account plus the device-bound login session inside the
 * writer transaction. Request auth extras are hints only; every E2EE security
 * decision below is re-established from durable state under the account lock.
 */
export async function lockAndValidateE2eeWriter(
    tx: Tx,
    accountId: string,
    auth: E2eeWriterAuth,
): Promise<AccountCryptoState> {
    const rows = await tx.$queryRawUnsafe<LockedWriterRow[]>(
        `SELECT a."id", a."cryptoMode", a."cryptoEpoch", a."cryptoWriteState", a."e2eeOrigin",
                s."id" AS "sessionId", s."deviceId" AS "sessionDeviceId",
                s."capabilities" AS "sessionCapabilities", s."e2eeProtocol" AS "sessionProtocol",
                s."expiresAt" AS "sessionExpiresAt", s."revokedAt" AS "sessionRevokedAt",
                d."id" AS "deviceId", d."status" AS "deviceStatus", d."keyEpoch" AS "deviceKeyEpoch",
                d."revokedAt" AS "deviceRevokedAt"
         FROM "Account" a
         LEFT JOIN "AccountLoginSession" s
           ON s."accountId" = a."id" AND s."id" = $2
         LEFT JOIN "CryptoDevice" d
           ON d."accountId" = a."id" AND d."id" = s."deviceId"
         WHERE a."id" = $1
         FOR UPDATE OF a`,
        accountId,
        auth.loginSessionId ?? null,
    );
    const row = rows[0];
    if (!row) throw new E2eeDataGuardError(426, 'e2ee_client_required');

    const account = normalizeAccountState(row);
    if (account.cryptoMode === 'trusted-v1') return account;
    if (account.cryptoMode === 'e2ee-migrating' || account.cryptoWriteState !== 'active') {
        throw new E2eeDataGuardError(409, 'e2ee_rekey_required');
    }
    if (
        account.cryptoMode !== 'e2ee-v1'
        || !account.e2eeOrigin
        || account.cryptoEpoch < 1
        || auth.e2eeProtocol !== E2EE_SUITE_V1
        || auth.deviceId === undefined
        || auth.loginSessionId === undefined
        || auth.capabilities?.length !== 1
        || auth.capabilities[0] !== E2EE_CONTROL_CAPABILITY
        || row.sessionId !== auth.loginSessionId
        || row.sessionDeviceId !== auth.deviceId
        || row.sessionProtocol !== E2EE_SUITE_V1
        || row.sessionCapabilities?.length !== 1
        || row.sessionCapabilities[0] !== E2EE_CONTROL_CAPABILITY
        || row.sessionRevokedAt !== null
        || row.sessionExpiresAt === null
        || new Date(row.sessionExpiresAt).getTime() <= Date.now()
        || row.deviceId !== auth.deviceId
        || row.deviceStatus !== 'active'
        || row.deviceRevokedAt !== null
        || row.deviceKeyEpoch !== account.cryptoEpoch
    ) {
        throw new E2eeDataGuardError(426, 'e2ee_client_required');
    }
    return account;
}

export function writerAuthFromRequest(request: {
    authLoginSessionId?: string;
    authDeviceId?: string;
    authCapabilities?: readonly string[];
    authE2eeProtocol?: string;
}): E2eeWriterAuth {
    return {
        loginSessionId: request.authLoginSessionId,
        deviceId: request.authDeviceId,
        capabilities: request.authCapabilities,
        e2eeProtocol: request.authE2eeProtocol,
    };
}
