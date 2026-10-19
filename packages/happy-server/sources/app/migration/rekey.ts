/**
 * B-636: re-wrap every column that HANDY_MASTER_SECRET protects, so a copied
 * database can live under a relay with a different master secret.
 *
 * What the master secret covers (grep encryptString / privacy-kit tokens):
 *   AccountSecret.secretEnc, AccountCredential.secretEnc   ['account', id, 'cloud-secret']  (vh1: + base64url)
 *   GithubUser.token (via Account.githubUserId)            ['user', accountId, 'github', 'token']
 *   ServiceAccountToken.token                               ['user', accountId, 'vendors', vendor, 'token']
 *   TeamAgentCredential.tokenEnc                            ['teams', teamId, botId, 'credential'] (base64)
 *   AccountLoginSession / OidcLoginChallenge / OidcLoginHandoff  tokens and challenges signed or wrapped
 *     with the old secret: unverifiable afterwards, so they are dropped (people sign in again).
 * End-to-end content (sessions, messages, machine metadata, data keys) is wrapped
 * with the account's own keys and is untouched.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { KeyTree, crypto as privacyCrypto } from 'privacy-kit';

type Database = PrismaClient | Prisma.TransactionClient;

export interface RekeyReport {
    accountSecrets: number;
    credentialSecrets: number;
    githubTokens: number;
    vendorTokens: number;
    teamCredentials: number;
    loginSessionsDropped: number;
    oidcRowsDropped: number;
    /** Rows whose ciphertext the OLD secret could not open; left as they were. */
    failed: string[];
}

export async function createMasterKeyTree(secret: string): Promise<KeyTree> {
    return new KeyTree(await privacyCrypto.deriveSecureKey({ key: secret, usage: 'happy-server-tokens' }));
}

const SECRET_PREFIX = 'vh1:';

export async function rekeyMasterSecret(client: Database, options: { from: string; to: string; apply: boolean }): Promise<RekeyReport> {
    if (options.from === options.to) throw new Error('old and new master secrets are identical');
    const oldTree = await createMasterKeyTree(options.from);
    const newTree = await createMasterKeyTree(options.to);
    const report: RekeyReport = { accountSecrets: 0, credentialSecrets: 0, githubTokens: 0, vendorTokens: 0, teamCredentials: 0, loginSessionsDropped: 0, oidcRowsDropped: 0, failed: [] };
    const rewrap = (path: string[], encrypted: Uint8Array): Uint8Array => newTree.symmetricEncrypt(path, oldTree.symmetricDecryptString(path, Uint8Array.from(encrypted)));

    for (const table of ['AccountSecret', 'AccountCredential'] as const) {
        const rows = await client.$queryRawUnsafe<Array<{ accountId: string; secretEnc: string }>>(`SELECT "accountId", "secretEnc" FROM "${table}"`);
        for (const row of rows) {
            const path = ['account', row.accountId, 'cloud-secret'];
            let next: string;
            try {
                // A pre-vh1 row holds the plaintext secret: wrap it under the new secret.
                const plain = row.secretEnc.startsWith(SECRET_PREFIX)
                    ? oldTree.symmetricDecryptString(path, new Uint8Array(Buffer.from(row.secretEnc.slice(SECRET_PREFIX.length), 'base64url')))
                    : row.secretEnc;
                next = SECRET_PREFIX + Buffer.from(newTree.symmetricEncrypt(path, plain)).toString('base64url');
            } catch {
                report.failed.push(`${table}:${row.accountId}`);
                continue;
            }
            if (options.apply) await client.$executeRawUnsafe(`UPDATE "${table}" SET "secretEnc" = $2 WHERE "accountId" = $1`, row.accountId, next);
            if (table === 'AccountSecret') report.accountSecrets++; else report.credentialSecrets++;
        }
    }

    const github = await client.$queryRawUnsafe<Array<{ id: string; accountId: string; token: Uint8Array }>>(
        `SELECT g."id", a."id" AS "accountId", g."token" FROM "GithubUser" g JOIN "Account" a ON a."githubUserId" = g."id" WHERE g."token" IS NOT NULL`,
    );
    for (const row of github) {
        try {
            const next = rewrap(['user', row.accountId, 'github', 'token'], new Uint8Array(row.token));
            if (options.apply) await client.githubUser.update({ where: { id: row.id }, data: { token: Buffer.from(next) } });
            report.githubTokens++;
        } catch {
            report.failed.push(`GithubUser:${row.id}`);
        }
    }

    const vendors = await client.$queryRawUnsafe<Array<{ id: string; accountId: string; vendor: string; token: Uint8Array }>>(
        `SELECT "id", "accountId", "vendor", "token" FROM "ServiceAccountToken"`,
    );
    for (const row of vendors) {
        try {
            const next = rewrap(['user', row.accountId, 'vendors', row.vendor, 'token'], new Uint8Array(row.token));
            if (options.apply) await client.serviceAccountToken.update({ where: { id: row.id }, data: { token: Buffer.from(next) } });
            report.vendorTokens++;
        } catch {
            report.failed.push(`ServiceAccountToken:${row.id}`);
        }
    }

    const bots = await client.$queryRawUnsafe<Array<{ id: string; teamId: string; botId: string; tokenEnc: string }>>(
        `SELECT "id", "teamId", "botId", "tokenEnc" FROM "TeamAgentCredential"`,
    );
    for (const row of bots) {
        try {
            const next = Buffer.from(rewrap(['teams', row.teamId, row.botId, 'credential'], new Uint8Array(Buffer.from(row.tokenEnc, 'base64')))).toString('base64');
            if (options.apply) await client.$executeRawUnsafe(`UPDATE "TeamAgentCredential" SET "tokenEnc" = $2 WHERE "id" = $1`, row.id, next);
            report.teamCredentials++;
        } catch {
            report.failed.push(`TeamAgentCredential:${row.id}`);
        }
    }

    const count = async (table: string) => Number((await client.$queryRawUnsafe<Array<{ count: unknown }>>(`SELECT COUNT(*) AS "count" FROM "${table}"`))[0]?.count ?? 0);
    report.loginSessionsDropped = await count('AccountLoginSession');
    report.oidcRowsDropped = await count('OidcLoginChallenge') + await count('OidcLoginHandoff');
    if (options.apply) {
        for (const table of ['AccountLoginSession', 'OidcLoginChallenge', 'OidcLoginHandoff']) await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    return report;
}
