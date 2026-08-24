import type { Prisma } from '@prisma/client';
import {
    AccountResourceLimitError,
    configuredResourceLimit,
    enforceAccountWriteRate,
} from '@/app/api/resourceLimits';

export async function enforceRelationshipWriteRate(accountId: string) {
    await enforceAccountWriteRate({
        accountId,
        resource: 'relationship',
        envName: 'MAX_RELATIONSHIP_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 60,
    });
}

export async function lockRelationshipAccounts(
    tx: Prisma.TransactionClient,
    firstAccountId: string,
    secondAccountId: string,
) {
    const ids = [firstAccountId, secondAccountId].sort();
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Account" WHERE "id" IN ($1, $2) ORDER BY "id" FOR UPDATE`,
        ids[0],
        ids[1],
    );
    if (rows.length !== 2) throw new Error('Relationship account not found');
}

export async function assertRelationshipCapacity(
    tx: Prisma.TransactionClient,
    accountId: string,
    createsRow: boolean,
) {
    if (!createsRow) return;
    const limit = configuredResourceLimit('MAX_RELATIONSHIPS_PER_ACCOUNT', 2_000);
    if (limit > 0 && await tx.userRelationship.count({ where: { fromUserId: accountId } }) >= limit) {
        throw new AccountResourceLimitError('relationship', 'count');
    }
}
