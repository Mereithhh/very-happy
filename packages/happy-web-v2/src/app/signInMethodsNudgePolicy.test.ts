import { describe, expect, it } from 'vitest';
import { shouldShowSignInMethodsNudge } from './signInMethodsNudgePolicy';

const emailOnly = {
    email: 'person@example.com',
    google: { connected: false, email: null },
    passwordConfigured: false,
    ssoConnected: false,
};
const base = { methods: emailOnly, passwordLoginEnabled: true, googleLoginEnabled: true, dismissedAt: undefined, pathname: '/' };

describe('B-668 sign-in methods nudge', () => {
    it('shows for an email-code-only account', () => {
        expect(shouldShowSignInMethodsNudge(base)).toBe(true);
        // old servers omit ssoConnected
        expect(shouldShowSignInMethodsNudge({ ...base, methods: { ...emailOnly, ssoConnected: undefined } })).toBe(true);
    });

    it('disappears once a password, Google or SSO identity exists', () => {
        expect(shouldShowSignInMethodsNudge({ ...base, methods: { ...emailOnly, passwordConfigured: true } })).toBe(false);
        expect(shouldShowSignInMethodsNudge({ ...base, methods: { ...emailOnly, google: { connected: true, email: null } } })).toBe(false);
        expect(shouldShowSignInMethodsNudge({ ...base, methods: { ...emailOnly, ssoConnected: true } })).toBe(false);
    });

    it('stays away when there is nothing to offer, no email identity, or not loaded yet', () => {
        expect(shouldShowSignInMethodsNudge({ ...base, passwordLoginEnabled: false, googleLoginEnabled: false })).toBe(false);
        expect(shouldShowSignInMethodsNudge({ ...base, passwordLoginEnabled: false })).toBe(true);
        expect(shouldShowSignInMethodsNudge({ ...base, methods: { ...emailOnly, email: null } })).toBe(false);
        expect(shouldShowSignInMethodsNudge({ ...base, methods: null })).toBe(false);
    });

    it('respects dismissal and never shows inside Settings', () => {
        expect(shouldShowSignInMethodsNudge({ ...base, dismissedAt: 1 })).toBe(false);
        expect(shouldShowSignInMethodsNudge({ ...base, pathname: '/settings/account' })).toBe(false);
        expect(shouldShowSignInMethodsNudge({ ...base, pathname: '/session/abc' })).toBe(true);
    });
});
