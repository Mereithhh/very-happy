/**
 * B-825: what a confirmed auth failure does to this browser's account data.
 *
 * Before: only a deliberate "Sign out" removed the account secret
 * (`auth_credentials`) and the `vh-sync-*` message cache. A revoked or
 * expired token (the auth latch, authLatch.ts) left both on disk until the
 * user happened to click "Sign in again" — closing the tab kept them forever.
 *
 * Now a tripped latch always ends in the local sign-out (AuthContext.logout,
 * which skips the server calls while latched): at once when nothing is
 * waiting to be sent, or after the user has seen the unsent inputs — wiping
 * the cache deletes the persistent outbox (B-814), so dropping them silently
 * would lose the user's text.
 *
 * What counts as confirmed is the latch's rule, not this module's: a 401 on
 * the current token from our own server. Network errors and 5xx never trip it
 * (server: `auth_unavailable` 503 when the token store cannot be read).
 *
 * Pure module (no React, no app imports).
 */

/** One input the server has not confirmed. `text` is null for attachments. */
export interface UnsentMessage {
    sessionId: string;
    localId: string;
    text: string | null;
}

export type AuthExpiredAction = 'sign-out-now' | 'confirm-unsent';

export function authExpiredAction(unsent: readonly UnsentMessage[]): AuthExpiredAction {
    return unsent.length === 0 ? 'sign-out-now' : 'confirm-unsent';
}

/** Clipboard text for "Copy unsent messages": the texts, oldest first, blank-line separated. */
export function unsentMessagesClipboardText(unsent: readonly UnsentMessage[]): string {
    return unsent
        .map((message) => message.text?.trim() ?? '')
        .filter((text) => text.length > 0)
        .join('\n\n');
}

/** The `localStorage` key holding the account token + secret (tokenStorage.ts, web). */
export const AUTH_CREDENTIALS_KEY = 'auth_credentials';

/**
 * Another tab removed the credentials (its sign-out or its own expiry wipe):
 * this tab's token is gone too. `storage` events fire only in OTHER tabs.
 */
export function isCredentialsRemovedEvent(event: { key: string | null; newValue: string | null }): boolean {
    // key === null: localStorage.clear() in another tab.
    return (event.key === AUTH_CREDENTIALS_KEY || event.key === null) && event.newValue === null;
}
