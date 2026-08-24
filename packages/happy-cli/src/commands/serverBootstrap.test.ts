import { describe, expect, it } from 'vitest';
import { resolveLocalSignupBootstrap } from './serverBootstrap';

describe('resolveLocalSignupBootstrap', () => {
    it('uses a generated invite for a fresh local server', () => {
        expect(resolveLocalSignupBootstrap(undefined, undefined, 'vh-bootstrap-test')).toEqual({
            signupMode: 'invite',
            signupInviteCodes: 'vh-bootstrap-test',
            generatedInviteCode: 'vh-bootstrap-test',
        });
    });

    it('preserves an operator-provided invite configuration', () => {
        expect(resolveLocalSignupBootstrap('invite', 'alpha,beta', 'unused')).toEqual({
            signupMode: 'invite',
            signupInviteCodes: 'alpha,beta',
        });
    });

    it('does not reopen an explicitly closed server', () => {
        expect(resolveLocalSignupBootstrap('closed', undefined, 'unused')).toEqual({
            signupMode: 'closed',
            signupInviteCodes: undefined,
        });
    });
});
