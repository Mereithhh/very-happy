import type { AccountLoginMethods } from '@/auth/cloudAuth';

/** B-668: `dismissedHints` key for the "add a code-free sign-in" card. */
export const SIGN_IN_METHODS_NUDGE_HINT = 'signin-methods-nudge';

/**
 * Show the card only while the account can sign in with email codes ALONE —
 * every new device then burns one of the address's 10 daily codes — and the
 * relay actually offers a way out (password or Google). Dismissal is per
 * device and permanent; the card also disappears by itself once a password,
 * Google or SSO identity exists. Never shown inside Settings, where the user
 * is already looking at the sign-in methods.
 */
export function shouldShowSignInMethodsNudge(input: {
    methods: AccountLoginMethods | null;
    passwordLoginEnabled: boolean;
    googleLoginEnabled: boolean;
    dismissedAt: number | undefined;
    pathname: string;
}): boolean {
    const { methods } = input;
    if (!methods || !methods.email) return false;
    if (methods.passwordConfigured || methods.google.connected || methods.ssoConnected === true) return false;
    if (!input.passwordLoginEnabled && !input.googleLoginEnabled) return false;
    if (typeof input.dismissedAt === 'number') return false;
    return !input.pathname.startsWith('/settings');
}
