import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

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
}, client: SqlClient = db): Promise<void> {
    const now = new Date();
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
    await client.$executeRawUnsafe(
        `UPDATE "${table(kind)}" SET "response" = $2, "responseAccountId" = $3, "updatedAt" = $4 WHERE "id" = $1 AND "response" IS NULL`,
        id, response, accountId, new Date(),
    );
}
