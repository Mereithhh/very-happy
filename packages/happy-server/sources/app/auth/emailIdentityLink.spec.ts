import { describe, expect, it, vi } from 'vitest';
import { getAccountLoginMethods } from './emailIdentityLink';

function fakeDb(identities: Array<{ provider: string; email: string | null; providerSubject: string }>, hasCredential: boolean) {
    return {
        $queryRawUnsafe: vi.fn(async (sql: string) => (
            sql.includes('FROM "AccountIdentity"') ? identities : [{ present: hasCredential }]
        )),
    } as any;
}

describe('getAccountLoginMethods', () => {
    it('B-668: an email-only account reports no code-free sign-in', async () => {
        await expect(getAccountLoginMethods(fakeDb([
            { provider: 'email', email: 'person@example.com', providerSubject: 'person@example.com' },
        ], false), 'account-1')).resolves.toEqual({
            email: 'person@example.com',
            google: { connected: false, email: null },
            passwordConfigured: false,
            ssoConnected: false,
        });
    });

    it('B-668: an SSO identity counts as a code-free sign-in', async () => {
        const methods = await getAccountLoginMethods(fakeDb([
            { provider: 'email', email: 'person@example.com', providerSubject: 'person@example.com' },
            { provider: 'oidc:https://sso.example.com', email: 'person@example.com', providerSubject: 'sub-1' },
        ], false), 'account-1');
        expect(methods.ssoConnected).toBe(true);
        expect(methods.google.connected).toBe(false);
    });
});
