import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRelationshipCapacity, lockRelationshipAccounts } from './relationshipLimits';

describe('relationship growth limits', () => {
    afterEach(() => delete process.env.MAX_RELATIONSHIPS_PER_ACCOUNT);

    it('locks both accounts in stable order before a two-sided relationship mutation', async () => {
        const query = vi.fn(async () => [{ id: 'a' }, { id: 'z' }]);
        await lockRelationshipAccounts({ $queryRawUnsafe: query } as any, 'z', 'a');
        expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY "id" FOR UPDATE'), 'a', 'z');
    });

    it('allows updates to existing rows but rejects a new row at the count boundary', async () => {
        process.env.MAX_RELATIONSHIPS_PER_ACCOUNT = '2';
        const tx = { userRelationship: { count: vi.fn(async () => 2) } } as any;
        await expect(assertRelationshipCapacity(tx, 'a', false)).resolves.toBeUndefined();
        await expect(assertRelationshipCapacity(tx, 'a', true)).rejects.toMatchObject({
            code: 'relationship_count_quota_exceeded',
            statusCode: 429,
        });
    });
});
