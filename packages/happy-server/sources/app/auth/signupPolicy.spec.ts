import { describe, expect, it } from 'vitest';
import { buildSignupStatus, getSignupRejection, resolveSignupPolicy, signupModeFor } from './signupPolicy';

describe('signup policy', () => {
    it('keeps legacy env compatibility', () => {
        expect(resolveSignupPolicy({ SIGNUP_CLOSED: 'true' } as NodeJS.ProcessEnv).mode).toBe('closed');
        expect(resolveSignupPolicy({ SIGNUP_INVITE_CODES: ' a, b ' } as NodeJS.ProcessEnv)).toMatchObject({
            mode: 'invite',
            inviteCodes: ['a', 'b'],
        });
        expect(resolveSignupPolicy({} as NodeJS.ProcessEnv).mode).toBe('closed');
    });

    it('lets explicit mode win and fails closed on invalid capacity configuration', () => {
        expect(resolveSignupPolicy({ SIGNUP_MODE: 'open', SIGNUP_CLOSED: 'true', SIGNUP_MAX_ACCOUNTS: '100' } as NodeJS.ProcessEnv))
            .toMatchObject({ mode: 'open', maxAccounts: 100 });
        expect(resolveSignupPolicy({ SIGNUP_MAX_ACCOUNTS: '0' } as NodeJS.ProcessEnv).maxAccounts).toBeNull();
        expect(() => resolveSignupPolicy({ SIGNUP_MAX_ACCOUNTS: 'wat' } as NodeJS.ProcessEnv)).toThrow('SIGNUP_MAX_ACCOUNTS');
        expect(() => resolveSignupPolicy({ SIGNUP_MODE: 'opne' } as NodeJS.ProcessEnv)).toThrow('SIGNUP_MODE');
    });

    it('applies mode before capacity', () => {
        const invite = { mode: 'invite', maxAccounts: 2, inviteCodes: ['ok'], oidcMode: null } as const;
        expect(getSignupRejection(invite, 1)).toBe('invite-required');
        expect(getSignupRejection(invite, 1, 'ok')).toBeNull();
        expect(getSignupRejection(invite, 2, 'ok')).toBe('capacity-reached');
        expect(getSignupRejection({ ...invite, mode: 'closed' }, 0, 'ok')).toBe('signup-closed');
    });

    it('lets OIDC_SIGNUP_MODE override the mode for OIDC first logins only', () => {
        const policy = resolveSignupPolicy({ SIGNUP_MODE: 'invite', SIGNUP_INVITE_CODES: 'ok', OIDC_SIGNUP_MODE: 'open', SIGNUP_MAX_ACCOUNTS: '2' } as NodeJS.ProcessEnv);
        expect(policy).toMatchObject({ mode: 'invite', oidcMode: 'open' });
        expect(signupModeFor(policy, 'oidc')).toBe('open');
        expect(signupModeFor(policy, 'google')).toBe('invite');
        expect(signupModeFor(policy)).toBe('invite');
        expect(getSignupRejection(policy, 1, undefined, 'oidc')).toBeNull();
        expect(getSignupRejection(policy, 1, undefined, 'email')).toBe('invite-required');
        expect(getSignupRejection(policy, 2, undefined, 'oidc')).toBe('capacity-reached');
        expect(resolveSignupPolicy({ SIGNUP_MODE: 'open', OIDC_SIGNUP_MODE: 'closed' } as NodeJS.ProcessEnv).oidcMode).toBe('closed');
        expect(resolveSignupPolicy({ SIGNUP_MODE: 'open' } as NodeJS.ProcessEnv).oidcMode).toBeNull();
        expect(() => resolveSignupPolicy({ OIDC_SIGNUP_MODE: 'yes' } as NodeJS.ProcessEnv)).toThrow('OIDC_SIGNUP_MODE');
    });

    it('reports remaining capacity without going negative', () => {
        expect(buildSignupStatus({ mode: 'open', maxAccounts: 100, inviteCodes: [], oidcMode: null }, 80)).toMatchObject({
            remainingAccounts: 20,
            atCapacity: false,
        });
        expect(buildSignupStatus({ mode: 'open', maxAccounts: 100, inviteCodes: [], oidcMode: null }, 101)).toMatchObject({
            remainingAccounts: 0,
            atCapacity: true,
        });
        expect(buildSignupStatus({ mode: 'open', maxAccounts: null, inviteCodes: [], oidcMode: null }, 999).remainingAccounts).toBeNull();
    });
});
