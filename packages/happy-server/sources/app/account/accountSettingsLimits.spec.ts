import { afterEach, describe, expect, it, vi } from 'vitest';

const allowAuthRequest = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/app/auth/authRateLimiter', () => ({ allowAuthRequest }));

import {
    ACCOUNT_SETTINGS_MAX_BYTES,
    accountSettingsUpdateSchema,
    enforceAccountSettingsWriteRate,
} from './accountSettingsLimits';

describe('account settings limits', () => {
    afterEach(() => {
        allowAuthRequest.mockReset();
        allowAuthRequest.mockResolvedValue(true);
        delete process.env.MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE;
    });

    it('caps the persisted value by UTF-8 bytes and rejects extra fields', () => {
        expect(accountSettingsUpdateSchema.safeParse({
            settings: 'x'.repeat(ACCOUNT_SETTINGS_MAX_BYTES),
            expectedVersion: 0,
        }).success).toBe(true);
        expect(accountSettingsUpdateSchema.safeParse({
            settings: '界'.repeat(Math.floor(ACCOUNT_SETTINGS_MAX_BYTES / 3) + 1),
            expectedVersion: 0,
        }).success).toBe(false);
        expect(accountSettingsUpdateSchema.safeParse({
            settings: null,
            expectedVersion: 0,
            ignored: true,
        }).success).toBe(false);
    });

    it('uses a shared per-account database write budget with a stable failure', async () => {
        process.env.MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE = '7';
        await enforceAccountSettingsWriteRate('account-1');
        expect(allowAuthRequest).toHaveBeenCalledWith(
            'resource-write:account_settings:account-1',
            { max: 7, windowMs: 60_000, cost: 1 },
        );

        allowAuthRequest.mockResolvedValueOnce(false);
        await expect(enforceAccountSettingsWriteRate('account-1')).rejects.toEqual(
            expect.objectContaining({
                code: 'account_settings_rate_quota_exceeded',
                statusCode: 429,
            }),
        );
    });
});
