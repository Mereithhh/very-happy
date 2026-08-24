import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AccountResourceLimitError,
    assertAccountResourceQuota,
    configuredResourceLimit,
    lockAccountResources,
    withinByteQuota,
} from './resourceLimits';

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
        expect(withinByteQuota(90, 10, 100)).toBe(true);
        expect(withinByteQuota(90, 11, 100)).toBe(false);
    });

    it('uses zero only as an explicit unlimited operator setting', () => {
        expect(withinByteQuota(1_000_000, 1, 0)).toBe(true);
    });

    it('accepts exact count/byte boundaries, charges deltas, and exposes stable errors', () => {
        expect(() => assertAccountResourceQuota({
            resource: 'artifact',
            current: { count: 9, bytes: 90 },
            delta: { count: 1, bytes: 10 },
            limits: { count: 10, bytes: 100 },
        })).not.toThrow();
        expect(() => assertAccountResourceQuota({
            resource: 'artifact',
            current: { count: 10, bytes: 90 },
            delta: { count: 1, bytes: 0 },
            limits: { count: 10, bytes: 100 },
        })).toThrow(expect.objectContaining({ code: 'artifact_count_quota_exceeded', statusCode: 429 }));
        expect(() => assertAccountResourceQuota({
            resource: 'kv',
            current: { count: 2, bytes: 90 },
            delta: { count: 0, bytes: 11 },
            limits: { count: 10, bytes: 100 },
        })).toThrow(expect.objectContaining({ code: 'kv_bytes_quota_exceeded', statusCode: 413 }));
        expect(() => assertAccountResourceQuota({
            resource: 'kv',
            current: { count: 10, bytes: 110 },
            delta: { count: 0, bytes: -20 },
            limits: { count: 10, bytes: 100 },
        })).not.toThrow();
        expect(new AccountResourceLimitError('usage_report', 'rate').code).toBe('usage_report_rate_quota_exceeded');
    });
});
