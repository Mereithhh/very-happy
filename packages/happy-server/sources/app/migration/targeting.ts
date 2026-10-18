import type { Prisma, PrismaClient } from '@prisma/client';
import { db } from '@/storage/db';
import type { MigrationSourceConfig } from './migrationConfig';

type Database = PrismaClient | Prisma.TransactionClient;

/**
 * B-627: who gets the banner and the daemon notice — an explicit account id
 * list, or any provider-verified (email / google / oidc) identity email whose
 * domain is listed. Password identities carry no email and never qualify.
 */
export async function isMigrationTargeted(config: MigrationSourceConfig, accountId: string, client: Database = db): Promise<boolean> {
    if (config.accountIds.has(accountId)) return true;
    if (config.emailDomains.size === 0) return false;
    const identities = await client.accountIdentity.findMany({ where: { accountId, email: { not: null } }, select: { email: true } });
    return identities.some((identity) => {
        const domain = identity.email?.split('@')[1]?.toLowerCase();
        return !!domain && config.emailDomains.has(domain);
    });
}
