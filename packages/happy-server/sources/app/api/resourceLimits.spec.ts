import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredResourceLimit, lockAccountResources, withinByteQuota, withinMessageQuota } from './resourceLimits';

describe('configurable resource limits', () => {
    afterEach(() => delete process.env.TEST_RESOURCE_LIMIT);

    it('uses safe defaults, accepts an explicit cap, and reserves zero for unlimited', () => {
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(20);
        process.env.TEST_RESOURCE_LIMIT = '4';
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(4);
        process.env.TEST_RESOURCE_LIMIT = '0';
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(0);
        process.env.TEST_RESOURCE_LIMIT = '-1';
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(20);
    });

    it('takes a database row lock so replicas serialize account reservations', async () => {
        const query = vi.fn(async () => [{ id: 'account-1' }]);
        await lockAccountResources({ $queryRawUnsafe: query } as any, 'account-1');
        expect(query).toHaveBeenCalledWith(expect.stringMatching(/FOR UPDATE/), 'account-1');
    });

    it('fails closed when the account row does not exist', async () => {
        await expect(lockAccountResources({ $queryRawUnsafe: vi.fn(async () => []) } as any, 'missing'))
            .rejects.toThrow('Account not found');
    });

    it('accepts the exact storage boundary and rejects the next byte or message', () => {
        expect(withinMessageQuota({ count: 9, bytes: 90 }, 10, { messages: 10, bytes: 100 })).toBe(true);
        expect(withinMessageQuota({ count: 10, bytes: 90 }, 1, { messages: 10, bytes: 100 })).toBe(false);
        expect(withinMessageQuota({ count: 9, bytes: 100 }, 1, { messages: 10, bytes: 100 })).toBe(false);
        expect(withinByteQuota(90, 10, 100)).toBe(true);
        expect(withinByteQuota(90, 11, 100)).toBe(false);
    });

    it('uses zero only as an explicit unlimited operator setting', () => {
        expect(withinMessageQuota({ count: 1_000_000, bytes: 1_000_000 }, 1, { messages: 0, bytes: 0 })).toBe(true);
        expect(withinByteQuota(1_000_000, 1, 0)).toBe(true);
    });
});
