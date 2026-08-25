import type { Prisma } from '@prisma/client';
import { decryptString, encryptString } from '@/modules/encrypt';

const SECRET_PREFIX = 'vh1:';

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export function encryptAccountSecret(accountId: string, secret: string): string {
    const encrypted = encryptString(['account', accountId, 'cloud-secret'], secret);
    return SECRET_PREFIX + Buffer.from(encrypted).toString('base64url');
}

export function decryptAccountSecret(accountId: string, stored: string): { secret: string; legacyPlaintext: boolean } {
    if (!stored.startsWith(SECRET_PREFIX)) {
        return { secret: stored, legacyPlaintext: true };
    }
    const encrypted = Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64url');
    return {
        secret: decryptString(['account', accountId, 'cloud-secret'], encrypted),
        legacyPlaintext: false,
    };
}

export async function upsertAccountSecret(client: SqlClient, accountId: string, secret: string): Promise<string> {
    const secretEnc = encryptAccountSecret(accountId, secret);
    await client.$executeRawUnsafe(
        `INSERT INTO "AccountSecret" ("accountId", "secretEnc", "updatedAt")
         VALUES ($1, $2, now())
         ON CONFLICT ("accountId") DO UPDATE SET "secretEnc" = EXCLUDED."secretEnc", "updatedAt" = now()`,
        accountId,
        secretEnc,
    );
    return secretEnc;
}

export async function loadAccountSecret(
    client: SqlClient,
    accountId: string,
    legacyCredentialSecret?: string,
): Promise<string | null> {
    const rows = await client.$queryRawUnsafe<{ secretEnc: string }[]>(
        'SELECT "secretEnc" FROM "AccountSecret" WHERE "accountId" = $1 LIMIT 1',
        accountId,
    );
    if (rows[0]) return decryptAccountSecret(accountId, rows[0].secretEnc).secret;
    if (legacyCredentialSecret === undefined) return null;

    const decoded = decryptAccountSecret(accountId, legacyCredentialSecret);
    await upsertAccountSecret(client, accountId, decoded.secret);
    if (decoded.legacyPlaintext) {
        const encrypted = encryptAccountSecret(accountId, decoded.secret);
        await client.$executeRawUnsafe(
            'UPDATE "AccountCredential" SET "secretEnc" = $1, "updatedAt" = now() WHERE "accountId" = $2',
            encrypted,
            accountId,
        );
    }
    return decoded.secret;
}
