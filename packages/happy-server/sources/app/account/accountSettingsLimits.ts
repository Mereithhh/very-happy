import { z } from 'zod';
import { enforceAccountWriteRate } from '@/app/api/resourceLimits';

export const ACCOUNT_SETTINGS_MAX_BYTES = 256 * 1024;

export const accountSettingsUpdateSchema = z.object({
    settings: z.string().refine(
        (value) => Buffer.byteLength(value, 'utf8') <= ACCOUNT_SETTINGS_MAX_BYTES,
        { message: `settings must be at most ${ACCOUNT_SETTINGS_MAX_BYTES} UTF-8 bytes` },
    ).nullable(),
    expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export async function enforceAccountSettingsWriteRate(accountId: string): Promise<void> {
    await enforceAccountWriteRate({
        accountId,
        resource: 'account_settings',
        envName: 'MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 60,
    });
}
