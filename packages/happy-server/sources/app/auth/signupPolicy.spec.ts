import { describe, expect, it } from 'vitest';
import { buildSignupStatus, getSignupRejection, resolveSignupPolicy } from './signupPolicy';

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
        const invite = { mode: 'invite', maxAccounts: 2, inviteCodes: ['ok'] } as const;
        expect(getSignupRejection(invite, 1)).toBe('invite-required');
        expect(getSignupRejection(invite, 1, 'ok')).toBeNull();
        expect(getSignupRejection(invite, 2, 'ok')).toBe('capacity-reached');
        expect(getSignupRejection({ ...invite, mode: 'closed' }, 0, 'ok')).toBe('signup-closed');
    });

    it('reports remaining capacity without going negative', () => {
        expect(buildSignupStatus({ mode: 'open', maxAccounts: 100, inviteCodes: [] }, 80)).toMatchObject({
            remainingAccounts: 20,
            atCapacity: false,
        });
        expect(buildSignupStatus({ mode: 'open', maxAccounts: 100, inviteCodes: [] }, 101)).toMatchObject({
            remainingAccounts: 0,
            atCapacity: true,
        });
        expect(buildSignupStatus({ mode: 'open', maxAccounts: null, inviteCodes: [] }, 999).remainingAccounts).toBeNull();
    });
});
