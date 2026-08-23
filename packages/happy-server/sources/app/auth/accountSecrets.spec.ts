import { beforeAll, describe, expect, it } from 'vitest';
import { initEncrypt } from '@/modules/encrypt';
import { decryptAccountSecret, encryptAccountSecret } from './accountSecrets';

describe('account secret storage', () => {
    beforeAll(async () => {
        process.env.HANDY_MASTER_SECRET = 'account-secret-test-master-key';
        await initEncrypt();
    });

    it('encrypts with a version marker and account-bound path', () => {
        const stored = encryptAccountSecret('a1', 'opaque-secret');
        expect(stored).toMatch(/^vh1:/);
        expect(stored).not.toContain('opaque-secret');
        expect(decryptAccountSecret('a1', stored)).toEqual({ secret: 'opaque-secret', legacyPlaintext: false });
        expect(() => decryptAccountSecret('a2', stored)).toThrow();
    });

    it('recognizes legacy plaintext for lazy migration', () => {
        expect(decryptAccountSecret('a1', 'legacy-secret')).toEqual({
            secret: 'legacy-secret',
            legacyPlaintext: true,
        });
    });
});
