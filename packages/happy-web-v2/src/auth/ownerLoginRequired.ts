/**
 * B-927a: owner-only actions (team owner actions, sharing, loosening project permissions) need a signed-in
 * login. An old device token gets `403 owner_login_required` (reused from B-921's Briefing handling): say so
 * and offer Account settings. Never a sign-out: a 403 does not trip the auth latch (auth/authLatch.ts).
 */
export const OWNER_LOGIN_REQUIRED = 'owner_login_required';

export function isOwnerLoginRequired(status: number, code: unknown): boolean {
    return status === 403 && code === OWNER_LOGIN_REQUIRED;
}

let lastShownAt = 0;
/** Shows the re-login prompt (at most once every 5 s, so a burst of failed calls is one toast). Returns whether it applied. */
export function notifyOwnerLoginRequired(status: number, code: unknown, now: number = Date.now()): boolean {
    if (!isOwnerLoginRequired(status, code)) return false;
    if (now - lastShownAt > 5000) {
        lastShownAt = now;
        // Loaded on demand: the request modules import this file, and Toast/text pull in the whole UI runtime.
        void Promise.all([import('@/ui/Toast'), import('@/text')]).then(([{ toast }, { t }]) => {
            toast.action(t('errors.ownerLoginRequired'), () => { window.location.assign('/settings/account'); });
        }).catch(() => {});
    }
    return true;
}
