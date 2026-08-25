import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { maxPendingAuthPairings, pairingExpiryCutoff } from './pairingSecurity';

export type PairingKind = 'terminal' | 'account';
export interface PairingRow {
    id: string;
    publicKey: string;
    supportsV2: boolean;
    claimSecretHash: string | null;
    response: string | null;
    responseAccountId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
const table = (kind: PairingKind) => kind === 'terminal' ? 'TerminalAuthRequest' : 'AccountAuthRequest';
const PAIRING_CREATE_LOCK_KEY = 'auth-pairing-create-cap';
export const PAIRING_RESPONSE_MAX_BYTES = 4_096;

export class PairingCapacityError extends Error {
    constructor() {
        super('pairing-capacity');
        this.name = 'PairingCapacityError';
    }
}

function validatePairingInput(input: { publicKey: string; claimSecretHash: string | null }): void {
    // privacy-kit encodeHex is the canonical encoder used by authRoutes and
    // returns uppercase A-F. Keep this strict so lookup and insertion cannot
    // disagree on key casing, but validate the casing the route actually uses.
    if (!/^[A-F0-9]{64}$/.test(input.publicKey)) {
        throw new Error('Pairing public key must be an uppercase 32-byte hex value');
    }
    if (input.claimSecretHash !== null && !/^[a-f0-9]{64}$/.test(input.claimSecretHash)) {
        throw new Error('Pairing claim secret hash must be a lowercase SHA-256 digest');
    }
}

export async function findPairing(kind: PairingKind, publicKey: string, client: SqlClient = db): Promise<PairingRow | null> {
    const supports = kind === 'terminal' ? '"supportsV2"' : 'false AS "supportsV2"';
    const rows = await client.$queryRawUnsafe<PairingRow[]>(
        `SELECT "id", "publicKey", ${supports}, "claimSecretHash", "response", "responseAccountId", "createdAt", "updatedAt"
         FROM "${table(kind)}" WHERE "publicKey" = $1 LIMIT 1`, publicKey,
    );
    return rows[0] ?? null;
}

export async function createPairing(kind: PairingKind, input: {
    publicKey: string;
    claimSecretHash: string | null;
    supportsV2?: boolean;
}, client?: SqlClient): Promise<void> {
    validatePairingInput(input);
    if (!client) {
        return db.$transaction((tx) => createPairing(kind, input, tx));
    }

    const now = new Date();
    const cutoff = pairingExpiryCutoff(now);

    // A durable singleton row gives every server replica the same transaction
    // lock without requiring a new table. Both pairing kinds share one cap.
    await client.$executeRawUnsafe(
        `INSERT INTO "GlobalLock" ("key", "value", "updatedAt", "expiresAt")
         VALUES ($1, $1, $2, $3)
         ON CONFLICT ("key") DO NOTHING`,
        PAIRING_CREATE_LOCK_KEY,
        now,
        new Date('9999-12-31T23:59:59.999Z'),
    );
    await client.$queryRawUnsafe(
        'SELECT "key" FROM "GlobalLock" WHERE "key" = $1 FOR UPDATE',
        PAIRING_CREATE_LOCK_KEY,
    );
    await client.$executeRawUnsafe(
        'DELETE FROM "TerminalAuthRequest" WHERE "createdAt" <= $1',
        cutoff,
    );
    await client.$executeRawUnsafe(
        'DELETE FROM "AccountAuthRequest" WHERE "createdAt" <= $1',
        cutoff,
    );
    const counts = await client.$queryRawUnsafe<Array<{ count: bigint | number | string }>>(
        `SELECT (
           (SELECT COUNT(*) FROM "TerminalAuthRequest") +
           (SELECT COUNT(*) FROM "AccountAuthRequest")
         ) AS "count"`,
    );
    if (Number(counts[0]?.count ?? 0) >= maxPendingAuthPairings()) {
        throw new PairingCapacityError();
    }

    if (kind === 'terminal') {
        await client.$executeRawUnsafe(
            `INSERT INTO "TerminalAuthRequest" ("id", "publicKey", "supportsV2", "claimSecretHash", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)`,
            randomUUID(), input.publicKey, input.supportsV2 ?? false, input.claimSecretHash, now,
        );
    } else {
        await client.$executeRawUnsafe(
            `INSERT INTO "AccountAuthRequest" ("id", "publicKey", "claimSecretHash", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$4)`,
            randomUUID(), input.publicKey, input.claimSecretHash, now,
        );
    }
}

export async function deletePairing(kind: PairingKind, id: string, client: SqlClient = db): Promise<number> {
    return client.$executeRawUnsafe(`DELETE FROM "${table(kind)}" WHERE "id" = $1`, id);
}

export async function approvePairingRow(kind: PairingKind, id: string, response: string, accountId: string, client: SqlClient = db): Promise<void> {
    if (Buffer.byteLength(response, 'utf8') > PAIRING_RESPONSE_MAX_BYTES) {
        throw new Error(`Pairing response must contain at most ${PAIRING_RESPONSE_MAX_BYTES} bytes`);
    }
    await client.$executeRawUnsafe(
        `UPDATE "${table(kind)}" SET "response" = $2, "responseAccountId" = $3, "updatedAt" = $4 WHERE "id" = $1 AND "response" IS NULL`,
        id, response, accountId, new Date(),
    );
}
